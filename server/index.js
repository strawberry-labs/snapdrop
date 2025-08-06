const process = require('process');
const uWS = require('uWebSockets.js');
const { uniqueNamesGenerator, animals, colors } = require('unique-names-generator');
const parser = require('ua-parser-js');

// Helper to generate a UUID
const generateUuid = () => {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
        const r = (Math.random() * 16) | 0;
        const v = c === 'x' ? r : (r & 0x3) | 0x8;
        return v.toString(16);
    });
};

const port = process.env.PORT || 3000;

const app = uWS.App().ws('/*', {
    /* Options */
    idleTimeout: 32, // More efficient than manual ping/pong
    maxBackpressure: 1024,
    maxPayloadLength: 512,

    /* This handler is called before upgrading the connection to a WebSocket */
    upgrade: (res, req, context) => {
        const ua = req.getHeader('user-agent');
        const ip = Buffer.from(res.getRemoteAddressAsText()).toString();
        
        // Handle x-forwarded-for behind a reverse proxy
        const forwardedFor = req.getHeader('x-forwarded-for');
        const realIp = forwardedFor ? forwardedFor.split(',')[0].trim() : ip;

        // --- Start of Cookie/Peer ID Logic ---
        let peerId;
        const cookie = req.getHeader('cookie');
        if (cookie) {
            const match = cookie.match(/peerid=([a-f0-9-]+)/);
            if (match) {
                peerId = match[1];
            }
        }

        if (!peerId) {
            peerId = generateUuid();
            // Note: uWS sends headers on upgrade, so we can set the cookie here.
            res.writeHeader('Set-Cookie', `peerid=${peerId}; SameSite=Strict; Secure`);
        }
        // --- End of Cookie/Peer ID Logic ---

        /* Pass peer data to the 'open' handler */
        res.upgrade({
                peerId: peerId,
                realIp: realIp,
                userAgent: ua
            },
            /* Upgrade headers */
            req.getHeader('sec-websocket-key'),
            req.getHeader('sec-websocket-protocol'),
            req.getHeader('sec-websocket-extensions'),
            context
        );
    },

    open: (ws) => {
        // Retrieve data from the upgrade handler
        ws.id = ws.peerId;
        ws.ip = ws.realIp;

        // In-memory room management
        const rooms = ws.getRooms();
        if (!rooms[ws.ip]) {
            rooms[ws.ip] = new Map();
        }

        // Parse user agent for device info
        const ua = parser(ws.userAgent);
        const deviceName = `${ua.os.name || ''} ${ua.browser.name || ''}`.trim() || 'Unknown Device';
        const displayName = uniqueNamesGenerator({
            dictionaries: [colors, animals],
            style: 'capital',
            separator: ' ',
            seed: ws.id // Use persistent ID as seed
        });

        ws.name = {
            deviceName,
            displayName,
            model: ua.device.model,
            os: ua.os.name,
            browser: ua.browser.name,
            type: ua.device.type,
        };
        
        // Subscribe to the room (topic) based on IP
        ws.subscribe(ws.ip);

        // Get info of other peers in the room
        const otherPeers = Array.from(rooms[ws.ip].values()).map(peer => peer.getInfo());

        // Send the list of existing peers to the new peer
        ws.send(JSON.stringify({
            type: 'peers',
            peers: otherPeers,
        }));

        // Add the new peer to the room
        rooms[ws.ip].set(ws.id, ws);
        
        // Announce the new peer to everyone else in the room
        ws.publish(ws.ip, JSON.stringify({
            type: 'peer-joined',
            peer: ws.getInfo(),
        }));
        
        // Send the peer its own display name info
        ws.send(JSON.stringify({
            type: 'display-name',
            message: {
                displayName: ws.name.displayName,
                deviceName: ws.name.deviceName
            }
        }));
    },

    message: (ws, message, isBinary) => {
        const msg = JSON.parse(Buffer.from(message).toString());

        if (msg.to) {
            // Find the recipient and send the message directly
            const room = ws.getRooms()[ws.ip];
            const recipient = room?.get(msg.to);
            if (recipient) {
                msg.sender = ws.id;
                delete msg.to;
                // Use send, not publish, for direct peer-to-peer messages
                recipient.send(JSON.stringify(msg), isBinary);
            }
        }
    },

    close: (ws, code, message) => {
        const rooms = ws.getRooms();
        const room = rooms[ws.ip];
        if (room) {
            room.delete(ws.id);
            if (room.size === 0) {
                delete rooms[ws.ip];
            } else {
                // Notify other peers that this peer has left
                ws.publish(ws.ip, JSON.stringify({
                    type: 'peer-left',
                    peerId: ws.id
                }));
            }
        }
    },
});

// A simple way to manage state without global variables
const serverState = {
    rooms: {},
};
app.getRooms = () => serverState.rooms;

// Add a helper to get peer info, attached to the prototype
uWS.WebSocket.prototype.getInfo = function() {
    return {
        id: this.id,
        name: this.name,
        rtcSupported: true, // Assume all modern clients support WebRTC
    };
};

app.listen(port, (token) => {
    if (token) {
        console.log(`Snapdrop is running on port ${port}`);
    } else {
        console.log(`Failed to listen to port ${port}`);
    }
});

// Graceful shutdown
process.on('SIGINT', () => {
    console.info("SIGINT Received, exiting...");
    process.exit(0);
});

process.on('SIGTERM', () => {
    console.info("SIGTERM Received, exiting...");
    process.exit(0);
});