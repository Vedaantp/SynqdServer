const express = require('express');
const http = require('http');
const { userInfo } = require('os');
const { start } = require('repl');
const socketIO = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = socketIO(server);

let activeServers = {};
const TIME_OUT = 900000;

app.use(express.json());

app.get('/serverStatus', (req, res) => {
    try {
        res.status(200).json({ status: "Server is online" });
    } catch {
        res.status(503).json({ error: 'Server is offline' });
    }
});

app.get('/amountServers', (req, res) => {
    try {
        const numberOfServers = Object.keys(activeServers).length;
        res.json({ numberOfServers });
    } catch {
        console.error('Error handling /amountServers:', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

app.get('/activeServers', (req, res) => {
    try {
        const serverInfo = Object.keys(activeServers).map((serverCode) => {
            const serverData = activeServers[serverCode];

            const startTime = new Date(serverData.startTime);
            const currentTime = new Date();
            const uptimeMilliseconds = currentTime - startTime;

            const hours = Math.floor(uptimeMilliseconds / 3600000);
            const minutes = Math.floor((uptimeMilliseconds % 3600000) / 60000);
            const seconds = Math.floor((uptimeMilliseconds % 60000) / 1000);

            return {
                serverCode,
                startTime: serverData.startTime,
                upTime: `${hours} hours ${minutes} minutes ${seconds} seconds`,
                host: {
                    userId: serverData.host.userId,
                    username: serverData.host.username,
                    lastHeartbeat: serverData.host.lastHeartbeat,
                },
                users: serverData.users.map((user) => ({
                    userId: user.userId,
                    username: user.username,
                    lastHeartbeat: user.lastHeartbeat,
                })),
                songRequests: serverData.votes,
            };
        });

        const prettifiedJSON = JSON.stringify({ servers: serverInfo }, null, 4);

        res.setHeader('Content-Type', 'application/json');
        res.send(prettifiedJSON);
    } catch (error) {
        console.error('Error handling /activeServers:', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// add a runtime to the servers

io.on('connection', (socket) => {
    socket.on('createServer', ({ username, userId }) => {
        const serverCode = generateUniqueCode();
        const currentDate = new Date();
        const formattedDate = currentDate.toISOString();
        activeServers[serverCode] = {
            startTime: formattedDate,
            users: [],
            host: {},
            timer: null,
            startTimer: true,
            heartbeatInterval: setInterval(() => { checkHeartbeats(serverCode) }, 60000),
            songRequests: [],
            votes: {},
            queueList: [],
        };
        activeServers[serverCode].host = { userId: userId, username: username, lastHeartbeat: Date.now() };
        socket.join(serverCode);
        socket.emit('serverCreated', { serverCode });
        io.to(serverCode).emit('updateUsers', { users: activeServers[serverCode].users, host: activeServers[serverCode].host });
        startTimerCycle(serverCode);
    });

    socket.on('updateHost', ({ serverCode, username, userId }) => {

        if (activeServers[serverCode]) {
            if (activeServers[serverCode].host.userId === userId) {
                activeServers[serverCode].host.username = username;
                activeServers[serverCode].host.lastHeartbeat = Date.now();
            }

            socket.join(serverCode);
            io.to(serverCode).emit('updateUsers', { users: activeServers[serverCode].users, host: activeServers[serverCode].host });
            io.to(serverCode).emit("hostRejoined");
        } else {
            socket.emit("joinError", { message: "Join unsuccessfull." });
        }
    });

    socket.on('updateUser', ({ serverCode, username, userId }) => {

        if (activeServers[serverCode]) {
            const userIndex = activeServers[serverCode].users.findIndex(user => user.userId === userId);

            if (userIndex !== -1) {
                activeServers[serverCode].users[userIndex].username = username;
                activeServers[serverCode].users[userIndex].lastHeartbeat = Date.now();
                socket.join(serverCode);
                io.to(serverCode).emit('updateUsers', { users: activeServers[serverCode].users, host: activeServers[serverCode].host });
                io.to(serverCode).emit('userJoined', { userId: userId });
            } else {

                socket.emit("rejoinError", { message: "Join unsuccessfull." });
            }


        } else {
            socket.emit("joinError", { message: "Join unsuccessfull." });
        }
    });

    socket.on('joinServer', ({ serverCode, username, userId }) => {
        const server = activeServers[serverCode];

        if (server) {
            if (server.users.length < 4) {
                server.users.push({ userId: userId, username: username, lastHeartbeat: Date.now() });
                socket.join(serverCode);
                io.to(serverCode).emit('updateUsers', { users: server.users, host: server.host });
                io.to(serverCode).emit('userJoined', { userId: userId });
            } else {
                socket.emit('serverFull');
            }
        } else {
            socket.emit("joinError", { message: "Join unsuccessfull." });
        }
    });

    socket.on('leaveServer', ({ serverCode, userId }) => {
        const server = activeServers[serverCode];

        if (server) {

            if (server.host.userId === userId) {
                io.to(serverCode).emit('hostLeft', { message: `Host left. ${serverCode} has closed.` });
                clearInterval(activeServers[serverCode].heartbeatInterval);
                server.startTimer = false;
                stopTimerCycle(serverCode);
                delete activeServers[serverCode];
            } else {
                server.users = server.users.filter((user) => user.userId !== userId);

                io.to(serverCode).emit('updateUsers', { users: server.users, host: server.host });
                io.to(serverCode).emit("userLeft", { userId: userId });
                io.to(serverCode).emit('userStoppedRejoin', { users: userId });

            }

        } else {
            io.emit('leaveError', { message: "Could not leave server successfully." });
        }
    });

    socket.on("kickUser", ({serverCode, kickId}) => {
        const server = activeServers[serverCode];

        if (server) {

            server.users = server.users.filter((user) => user.userId !== kickId);

            io.to(serverCode).emit('updateUsers', { users: server.users, host: server.host });
            io.to(serverCode).emit("kickedUser", { userId: kickId });

        } else {
            io.emit('leaveError', { message: "Could not leave server successfully." });
        }

    });

    socket.on('getUsers', ({ serverCode }) => {
        const server = activeServers[serverCode];
        if (server) {
            io.to(socket.id).emit('userList', { host: server.host, users: server.users });
        }
    });

    socket.on("heartbeat", ({ serverCode, userId }) => {
        const server = activeServers[serverCode];

        if (server && server.host.userId === userId) {
            server.host.lastHeartbeat = Date.now();
            io.to(serverCode).emit('heartbeatReceived', { message: activeServers[serverCode].host.lastHeartbeat });
        }

        else if (server) {
            const userIndex = activeServers[serverCode].users.findIndex(user => user.userId === userId);

            if (userIndex !== -1) {
                activeServers[serverCode].users[userIndex].lastHeartbeat = Date.now();
            }
        }
    });

    socket.on("songRequest", ({ serverCode, userId, songInfo }) => {
        const server = activeServers[serverCode];

        if (server) {
            const userIndex = activeServers[serverCode].users.findIndex(user => user.userId === userId);

            if (userIndex !== -1) {
                if (songInfo.uri !== '') {
                    activeServers[serverCode].songRequests.push(songInfo);
                    sendSongRequests(serverCode);
                }
            }
        }
    });

    socket.on("getVotedSong", ({ serverCode, userId }) => {
        const server = activeServers[serverCode];

        if (server) {
            if (userId === server.host.userId) {
                calculateTopSong(serverCode);
            }
        }
    });

    socket.on("songInfo", ({ serverCode, userId, songInfo }) => {
        const server = activeServers[serverCode];

        if (server) {
            if (server.host.userId === userId) {
                io.to(serverCode).emit("currentSongInfo", {songInfo});
            }
        }
    });

    socket.on("sessionTime", ({serverCode}) => {
        const server = activeServers[serverCode];

        if (server) {
            const startTime = new Date(server.startTime);
            const currentTime = new Date();
            const uptimeMilliseconds = currentTime - startTime;

            const hours = Math.floor(uptimeMilliseconds / 3600000);
            const minutes = Math.floor((uptimeMilliseconds % 3600000) / 60000);
            const seconds = Math.floor((uptimeMilliseconds % 60000) / 1000);

            io.to(serverCode).emit("currentSessionTime", {hours: hours, minutes: minutes, seconds: seconds});
        }
    });

    socket.on("joinServerCode", ({serverCode}) => {
        const server = activeServers[serverCode];

        if (server) {
            socket.join(serverCode);
            io.to(serverCode).emit("connectedToCode", {message: "Connected"});
            io.to(serverCode).emit('updateUsers', { users: server.users, host: server.host });
        }
    });

    socket.on("hostQueueList", ({songs, serverCode}) => {
        const server = activeServers[serverCode];

        if (server) {
            activeServers[serverCode].queueList = songs;

            io.to(serverCode).emit("queueListUpdate", { songs: activeServers[serverCode].queueList });
        }

    });

    socket.on("queueList", ({serverCode}) => {
        const server = activeServers[serverCode];

        if (server) {
            io.to(serverCode).emit("queueListUpdate", { songs: activeServers[serverCode].queueList });
        }
    });

    socket.on("votingSong", ({serverCode, songInfo, userId}) => {
        const server = activeServers[serverCode];

        if (server) {
            if (activeServers[serverCode].votes[songInfo.uri]) {
                if (activeServers[serverCode].votes[songInfo.uri].votes.includes(userId)) {
                    activeServers[serverCode].votes[songInfo.uri].votes = activeServers[serverCode].votes[songInfo.uri].votes.filter(item => item !== userId);
                } else {
                    activeServers[serverCode].votes[songInfo.uri].votes.push(userId);
                }
            } else {
                activeServers[serverCode].votes[songInfo.uri] = {
                    votes: [userId,],
                    name: songInfo.name,
                    artists: songInfo.artist,
                    image: songInfo.image,
                };
            }

            calcVotes(serverCode, false);
        }

    });

    socket.on("getVoteList", ({serverCode}) => {
        const server = activeServers[serverCode];

        if (server) {
            calcVotes(serverCode, false);
        }
    });

});

function generateUniqueCode() {
    let code;

    do {
        code = Math.floor(100000 + Math.random() * 900000).toString();
    } while (activeServers[code]);

    return code;
}

function startTimerCycle(serverCode) {
    const server = activeServers[serverCode];

    function startTimer(interval) {

        activeServers[serverCode].timer = setInterval(() => {
            interval -= 1000;

            if (interval <= 0) {
                clearInterval(activeServers[serverCode].timer);

                if (activeServers[serverCode].startTimer) {
                    calcVotes(serverCode, true);
                    startTimer(30000);
                }
            }

        }, 1000);

    }

    if (server && server.startTimer) {
        startTimer(30000);
    }

}

function sendSongRequests(serverCode) {
    io.to(serverCode).emit("requestedSongs", { songs: activeServers[serverCode].songRequests });
}

function calcVotes(serverCode, endTimer) {
    const server = activeServers[serverCode];

    if (server) {
        if (Object.keys(activeServers[serverCode].votes).length === 0) {
            if (endTimer) {
                io.to(serverCode).emit("songVoted", {songInfo: null});
            }

            io.to(serverCode).emit("updateVoteList", {votes: []});

        } else {
            let orderedList = orderList(serverCode);

            if (endTimer) {
                io.to(serverCode).emit("songVoted", {songInfo: orderedList[0]});
                delete activeServers[serverCode].votes[orderedList[0].uri];
                orderedList.shift();
                // delete the voted song from list
            }

            // without the voted song
            io.to(serverCode).emit("updateVoteList", {votes: orderedList});
        }
    }
}

function orderList(serverCode) {
    const server = activeServers[serverCode];

    if (server) {
        let votesArray = Object.keys(activeServers[serverCode].votes).map((key) => ({
            uri: key,
            votes: activeServers[serverCode].votes[key].votes,
            name: activeServers[serverCode].votes[key].name,
            artists: activeServers[serverCode].votes[key].artists,
            image: activeServers[serverCode].votes[key].image,
          }));
        
          // Sort the array by the "votes" property in descending order
          return votesArray.sort((a, b) => b.votes.length - a.votes.length);
    }

}

function calculateTopSong(serverCode) {

    let song;

    const maxValue = Math.max(...Object.values(activeServers[serverCode].votes));

    const keysWithMaxValue = Object.keys(activeServers[serverCode].votes).filter(key => activeServers[serverCode].votes[key] === maxValue);

    if (keysWithMaxValue.length > 1) {
        const randomIndex = Math.floor(Math.random() * keysWithMaxValue.length);
        song = keysWithMaxValue[randomIndex];
    } else {
        song = keysWithMaxValue[0];
    }


    if (song) {
        io.to(serverCode).emit("votedSong", { uri: song });
    } else {
        io.to(serverCode).emit('votedSong', { uri: '' });
    }

    activeServers[serverCode].votes = {};

}

function stopTimerCycle(serverCode) {
    // Clear the active timer if it exists
    if (activeServers[serverCode].timer) {
        activeServers[serverCode].startTimer = false;
        clearInterval(activeServers[serverCode].timer);
        activeServers[serverCode].timer = null;
    }
}

const checkHeartbeats = (serverCode) => {
    const currentTime = Date.now();

    if (activeServers[serverCode]) {
        if (currentTime - activeServers[serverCode].host.lastHeartbeat > TIME_OUT) {
            io.to(serverCode).emit('hostTimedOut', { message: `Host left. ${serverCode} has closed.` });
            clearInterval(activeServers[serverCode].heartbeatInterval);
            server.startTimer = false;
            stopTimerCycle(serverCode);
            delete activeServers[serverCode];
        }
    }

    if (activeServers[serverCode]) {
        for (user of activeServers[serverCode].users) {
            if (currentTime - user.lastHeartbeat > TIME_OUT) {
                const userId = user.userId;
                activeServers[serverCode].users = activeServers[serverCode].users.filter((user) => user.userId !== userId);
                io.to(serverCode).emit('updateUsers', { users: activeServers[serverCode].users, host: activeServers[serverCode].host });
                io.to(serverCode).emit('userTimedOut', { userId: userId });
            }
        }
    }

}



const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
    console.log(`Server running on port: ${PORT}`);
});