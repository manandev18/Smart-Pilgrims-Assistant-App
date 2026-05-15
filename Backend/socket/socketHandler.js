import { Server } from 'socket.io';
import jwt from 'jsonwebtoken';
import axios from 'axios';
import LocationLog from '../models/LocationLog.js';
import GuardianMapping from '../models/GuardianMapping.js';
import SOSAlert from '../models/SOSAlert.js';
import Client from '../models/client.js';
import { sendSOSEmail } from '../utils/emailService.js';

const userSocketMap = new Map(); // userId -> socketId
const lastSavedPosMap = new Map(); // userId -> {lat, lng}

// Haversine distance helper (metres)
const getDistance = (lat1, lon1, lat2, lon2) => {
    const R = 6371e3;
    const φ1 = lat1 * Math.PI / 180;
    const φ2 = lat2 * Math.PI / 180;
    const Δφ = (lat2 - lat1) * Math.PI / 180;
    const Δλ = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
              Math.cos(φ1) * Math.cos(φ2) *
              Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
};

export const initSocket = (server) => {
    const io = new Server(server, {
        pingTimeout: 30000,
        pingInterval: 10000,
        cors: {
            origin: "*", // Adjust this in production
            methods: ["GET", "POST"]
        }
    });

    // Authentication Middleware
    io.use((socket, next) => {
        const token = socket.handshake.auth.token || socket.handshake.headers.token;
        if (!token) {
            return next(new Error('Authentication error: No token provided'));
        }

        jwt.verify(token, process.env.JWT_SECRET, (err, decoded) => {
            if (err) return next(new Error('Authentication error: Invalid token'));
            socket.user = decoded;
            next();
        });
    });

    io.on('connection', (socket) => {
        const userId = socket.user.client_id;
        console.log(`User connected: ${userId} (Socket: ${socket.id})`);
        
        userSocketMap.set(userId, socket.id);

        // Join a private room for the user
        socket.join(`user_${userId}`);

        // Handle Live Location Update
        socket.on('sendLocation', async (data) => {
            const { lat, lng } = data;
            if (!lat || !lng) return;

            try {
                // 1. Find all approved guardians FIRST
                const mappings = await GuardianMapping.findAll({
                    where: { user_id: userId, is_approved: true },
                    attributes: ['guardian_id']
                });

                // 2. IMMEDIATELY broadcast to each guardian (zero delay)
                const payload = { userId, lat, lng, timestamp: new Date() };
                mappings.forEach(mapping => {
                    io.to(`user_${mapping.guardian_id}`).emit('receiveLocation', payload);
                });

                // 3. Save to DB async (non-blocking) — only if user moved > 10m
                const lastPos = lastSavedPosMap.get(userId);
                const distanceMoved = lastPos ? getDistance(lastPos.lat, lastPos.lng, lat, lng) : Infinity;

                if (distanceMoved >= 10) {
                    LocationLog.create({ user_id: userId, lat, lng })
                        .then(() => {
                            lastSavedPosMap.set(userId, { lat, lng });
                        })
                        .catch(e => console.error('Location log save error:', e.message));
                }

            } catch (error) {
                console.error('Error processing location update:', error);
            }
        });

        // Handle SOS Alert
        socket.on('sosAlert', async (data) => {
            const { lat, lng } = data;
            
            try {
                // 1. Save SOS to DB
                const sos = await SOSAlert.create({
                    client_id: userId,
                    lat,
                    lng,
                    status: 'active'
                });

                // 3. Get User Info
                const user = await Client.findByPk(userId);

                // 3a. Fetch Nearby Emergency Services (Police & Hospital)
                let nearbyServices = [];
                try {
                    const apiKey = process.env.GEOAPIFY_API_KEY;
                    if (apiKey) {
                        const categories = 'healthcare.hospital,service.police';
                        const url = `https://api.geoapify.com/v2/places?categories=${categories}&filter=circle:${lng},${lat},5000&bias=proximity:${lng},${lat}&limit=5&apiKey=${apiKey}`;
                        const geoRes = await axios.get(url);
                        nearbyServices = geoRes.data.features.map(f => ({
                            name: f.properties.name || f.properties.street || 'Emergency Unit',
                            address: f.properties.address_line2 || f.properties.formatted,
                            lat: f.properties.lat,
                            lng: f.properties.lon,
                            category: f.properties.categories.includes('healthcare') ? 'hospital' : 'police',
                            distance: f.properties.distance
                        }));
                    }
                } catch (geoErr) {
                    console.error('Nearby services fetch failed:', geoErr.message);
                }

                // 4. Notify Guardians
                const mappings = await GuardianMapping.findAll({
                    where: { user_id: userId, is_approved: true },
                    attributes: ['guardian_id']
                });

                const alertData = {
                    sosId: sos.sos_id,
                    userId,
                    userName: user.name,
                    lat,
                    lng,
                    nearbyServices,
                    timestamp: new Date()
                };

                mappings.forEach(mapping => {
                    io.to(`user_${mapping.guardian_id}`).emit('SOS_RECEIVED', alertData);
                });

                // 5. Notify Admins
                io.emit('SOS_ADMIN_ALERT', alertData);

                // 6. Send Email Alert in background
                const adminEmail = process.env.ADMIN_EMAIL || process.env.SMTP_USER;
                if (adminEmail) {
                    sendSOSEmail(adminEmail, {
                        user,
                        location: { lat, lng },
                        nearbyServices
                    }).catch(emailErr => console.error('SOS Email failed:', emailErr.message));
                }

                console.log(`SOS Alert triggered by user ${userId}`);
            } catch (error) {
                console.error('Error processing SOS alert:', error);
            }
        });

        // Handle Tracking Session Start
        socket.on('startTracking', async (data) => {
            const { guardianId, src, dest } = data;
            if (!guardianId) return;

            try {
                // Get Current User Info
                const user = await Client.findByPk(userId);

                const alertData = {
                    userId,
                    userName: user.name,
                    src,
                    dest,
                    timestamp: new Date()
                };

                // Notify the specific guardian
                io.to(`user_${guardianId}`).emit('TRACKING_STARTED', alertData);
                console.log(`Tracking session started for user ${userId} with guardian ${guardianId}`);
            } catch (error) {
                console.error('Error starting tracking session:', error);
            }
        });

        // Handle Tracking Session Stop
        socket.on('stopTracking', async (data) => {
            const { guardianId } = data;
            if (!guardianId) return;

            io.to(`user_${guardianId}`).emit('TRACKING_STOPPED', { userId });
            console.log(`Tracking session stopped for user ${userId}`);
        });

        socket.on('disconnect', () => {
            console.log(`User disconnected: ${userId}`);
            userSocketMap.delete(userId);
        });
    });

    return io;
};
