const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const { v4: uuidv4 } = require("uuid");
const { generateResponse } = require("./services/openai");
const {
  saveUser,
  createRoom,
  addUserToRoom,
  saveMessage,
  getRoom,
  updateRoom,
  updateUserRoomAccess,
  getRoomCollaborators,
  trackUserRoomHistory,
  getUserChatHistory,
  removeUserChat,
} = require("./services/firestore");
require("dotenv").config();

// Set up CORS options
const corsOptions = {
  origin: [
    process.env.FRONTEND_URL || "https://collabgpt-production.up.railway.app",
    "http://localhost:5173", // Keep for local development
  ],
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With"],
  maxAge: 86400, // 24 hours
};

// Initialize Express app
const app = express();
app.use(cors(corsOptions));
app.use(express.json());

// Add CORS headers to all responses
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.header(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, X-Requested-With"
  );
  if (req.method === "OPTIONS") {
    return res.sendStatus(200);
  }
  next();
});

// Create HTTP server
const server = http.createServer(app);

// Initialize Socket.IO
const io = new Server(server, {
  cors: {
    origin: process.env.FRONTEND_URL || "*", // Get from environment or allow all temporarily
    methods: ["GET", "POST"],
  },
});

// In-memory cache of active rooms and their users (for quick lookup)
const activeRooms = new Map();
// Track typing status with debounce timeouts
const typingTimeouts = new Map();

// Socket.IO connection handler
io.on("connection", (socket) => {
  console.log(`User connected: ${socket.id}`);

  // Keep track of which rooms this socket has joined
  const joinedRooms = new Set();

  // Handle user explicitly leaving a room
  socket.on("leave-room", ({ roomId }) => {
    if (!roomId) return;

    try {
      console.log(`User ${socket.id} leaving room ${roomId}`);

      // Remove from joined rooms set
      joinedRooms.delete(roomId);

      // Leave the socket.io room
      socket.leave(roomId);

      const activeRoom = activeRooms.get(roomId);
      if (activeRoom && activeRoom.users.has(socket.id)) {
        const user = activeRoom.users.get(socket.id);
        activeRoom.users.delete(socket.id);

        // Clear any typing timeouts for this user
        if (typingTimeouts.has(socket.id)) {
          clearTimeout(typingTimeouts.get(socket.id));
          typingTimeouts.delete(socket.id);
        }

        // Notify others in the room
        io.to(roomId).emit("user-left", {
          userId: user.id,
          socketId: socket.id,
          users: Array.from(activeRoom.users.values()),
        });

        // Only remove room from memory if no active users
        if (activeRoom.users.size === 0) {
          activeRooms.delete(roomId);
          console.log(`Room ${roomId} removed from active rooms (no users)`);
        }
      }
    } catch (error) {
      console.error(`Error leaving room ${roomId}:`, error);
    }
  });

  // Enhance the join-room handler to better handle room switching
  socket.on("join-room", async ({ roomId, user }) => {
    try {
      // Generate a new room ID if none provided
      if (!roomId) {
        roomId = uuidv4();
      }

      // If this socket was already in a room, clean it up
      joinedRooms.forEach((oldRoomId) => {
        if (oldRoomId !== roomId) {
          console.log(
            `Cleaning up previous room ${oldRoomId} for socket ${socket.id}`
          );
          socket.leave(oldRoomId);
          joinedRooms.delete(oldRoomId);

          // Remove user from active room
          const oldRoom = activeRooms.get(oldRoomId);
          if (oldRoom && oldRoom.users.has(socket.id)) {
            const oldUser = oldRoom.users.get(socket.id);
            oldRoom.users.delete(socket.id);

            // Notify others
            socket.to(oldRoomId).emit("user-left", {
              userId: oldUser.id,
              socketId: socket.id,
              users: Array.from(oldRoom.users.values()),
            });
          }
        }
      });

      // Record that this socket joined this room
      joinedRooms.add(roomId);

      // Join the room
      socket.join(roomId);

      // Safe user object with default values if not provided
      const safeUser = user
        ? {
            uid: user.uid,
            displayName: user.displayName || "Anonymous",
            email: user.email,
            photoURL: user.photoURL,
          }
        : {
            uid: socket.id,
            displayName: "Anonymous",
            email: null,
            photoURL: null,
          };

      // Create room if it doesn't exist or get existing room
      let roomData;

      // Check if room is already in memory cache
      if (!activeRooms.has(roomId)) {
        try {
          // Try to fetch from Firestore
          roomData = await getRoom(roomId);

          // Convert Firestore timestamps to JavaScript dates and ensure correct order
          roomData.messages = roomData.messages
            .map((msg) => ({
              ...msg,
              timestamp: msg.timestamp?.toDate() || new Date(),
              createdAt: msg.createdAt?.toDate() || new Date(),
            }))
            .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

          // Initialize in-memory storage for active users
          activeRooms.set(roomId, {
            users: new Map(),
            chatInfo: {
              title: roomData.title,
              description: roomData.description || "",
              createdAt: roomData.createdAt?.toDate() || new Date(),
            },
          });
        } catch (error) {
          // Room doesn't exist, create a new one
          const roomCreationData = await createRoom(safeUser, { roomId });

          // Initialize in-memory structure
          activeRooms.set(roomId, {
            users: new Map(),
            chatInfo: {
              title: roomCreationData.title,
              description: roomCreationData.description || "",
              createdAt: roomCreationData.createdAt,
            },
          });

          roomData = roomCreationData;
        }
      } else {
        roomData = await getRoom(roomId);

        // Convert Firestore timestamps and ensure correct order
        roomData.messages = roomData.messages?.length
          ? roomData.messages
              .map((msg) => {
                // Safely convert timestamp - check if it's already a Date
                const timestamp =
                  msg.timestamp instanceof Date
                    ? msg.timestamp
                    : msg.timestamp?.toDate
                    ? msg.timestamp.toDate()
                    : new Date();

                const createdAt =
                  msg.createdAt instanceof Date
                    ? msg.createdAt
                    : msg.createdAt?.toDate
                    ? msg.createdAt.toDate()
                    : new Date();

                return {
                  ...msg,
                  timestamp,
                  createdAt,
                };
              })
              .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime())
          : [];
      }

      // Add user to room if authenticated
      if (safeUser.uid !== socket.id) {
        try {
          // Save user to database
          await saveUser(safeUser);

          // Add to room if not already a participant
          if (!roomData.participants || !roomData.participants[safeUser.uid]) {
            await addUserToRoom(roomId, safeUser);
          } else {
            // Update last access time for existing room participant
            await updateUserRoomAccess(safeUser.uid, roomId);
          }

          // Get active room memory cache
          const activeRoom = activeRooms.get(roomId);

          // Track this room in user's history
          await trackUserRoomHistory(safeUser.uid, roomId, {
            title: activeRoom.chatInfo.title,
            lastMessage: roomData.lastMessage,
            createdAt: activeRoom.chatInfo.createdAt,
          });
        } catch (error) {
          console.error("Error adding user to room:", error);
        }
      }

      // Get active room memory cache
      const activeRoom = activeRooms.get(roomId);

      // Add user to active users
      const userData = {
        id: safeUser.uid,
        name: safeUser.displayName,
        photoURL: safeUser.photoURL,
        socketId: socket.id,
      };

      // Check if this user already exists in the room (by user ID)
      let userExists = false;
      let oldSocketId = null;

      // Check active users in memory
      const existingUsers = Array.from(activeRoom.users.values());
      for (const existingUser of existingUsers) {
        if (existingUser.id === safeUser.uid) {
          userExists = true;
          oldSocketId = existingUser.socketId;
          // Update the user data but keep the same user ID
          activeRoom.users.delete(oldSocketId);
          break;
        }
      }

      // Add or update the user in active users
      activeRoom.users.set(socket.id, userData);

      // Log appropriate message
      if (userExists) {
        console.log(
          `User ${safeUser.uid} reconnected to room ${roomId} with new socket ${socket.id}`
        );
      } else {
        console.log(`User ${safeUser.uid} joined room ${roomId}`);
      }

      // Notify everyone in the room about the user
      io.to(roomId).emit("user-joined", {
        roomId,
        user: userData,
        users: Array.from(activeRoom.users.values()),
      });

      // Send room history to the user
      socket.emit("room-history", {
        roomId,
        users: Array.from(activeRoom.users.values()),
        messages: roomData.messages,
        chatInfo: activeRoom.chatInfo,
      });
    } catch (error) {
      console.error("Error in join-room handler:", error);
      socket.emit("error", { message: "Failed to join room" });
    }
  });

  // Handle get collaborators request
  socket.on("get-collaborators", async ({ roomId }) => {
    try {
      if (!roomId) {
        socket.emit("error", { message: "Room ID is required" });
        return;
      }

      // Get collaborators from database
      const collaborators = await getRoomCollaborators(roomId);

      // Send collaborators to the requester
      socket.emit("collaborators", { roomId, collaborators });
    } catch (error) {
      console.error("Error getting collaborators:", error);
      socket.emit("error", { message: "Failed to get collaborators" });
    }
  });

  // Handle new chat message
  socket.on("send-message", async ({ roomId, message }) => {
    try {
      const activeRoom = activeRooms.get(roomId);
      if (!activeRoom) {
        socket.emit("error", { message: "Room not found" });
        return;
      }

      const user = activeRoom.users.get(socket.id);
      if (!user) {
        socket.emit("error", { message: "User not found in room" });
        return;
      }

      const newMessage = {
        id: message.id || uuidv4(), // Use provided ID or generate one
        userId: user.id,
        userName: user.name,
        userPhotoURL: user.photoURL,
        content: message.content,
        role: message.role || "user",
        timestamp: new Date(),
      };

      // Store message in Firestore
      await saveMessage(roomId, newMessage);

      // Auto-generate title from the first user message if it doesn't have a custom title
      if (activeRoom.chatInfo.title === "New Conversation") {
        const titleContent = message.content.substring(0, 30);
        const newTitle =
          titleContent + (message.content.length > 30 ? "..." : "");

        // Update in-memory cache
        activeRoom.chatInfo.title = newTitle;

        // Update in Firestore
        await updateRoom(roomId, { title: newTitle });

        // Broadcast updated chat info
        io.to(roomId).emit("chat-info-updated", activeRoom.chatInfo);
      }

      // Broadcast message to everyone in the room
      io.to(roomId).emit("new-message", newMessage);
    } catch (error) {
      console.error("Error sending message:", error);
      socket.emit("error", { message: "Failed to send message" });
    }
  });

  // Handle user typing indicator
  socket.on("user-typing", ({ roomId }) => {
    try {
      const activeRoom = activeRooms.get(roomId);
      if (!activeRoom) return;

      const user = activeRoom.users.get(socket.id);
      if (!user) return;

      // Clear any existing timeout for this user
      if (typingTimeouts.has(socket.id)) {
        clearTimeout(typingTimeouts.get(socket.id));
      }

      // Broadcast to everyone except the sender that this user is typing
      socket.to(roomId).emit("typing-indicator", {
        userId: user.id,
        userName: user.name,
        isTyping: true,
      });

      // Set timeout to automatically clear typing status after 3 seconds
      const timeout = setTimeout(() => {
        socket.to(roomId).emit("typing-indicator", {
          userId: user.id,
          userName: user.name,
          isTyping: false,
        });
        typingTimeouts.delete(socket.id);
      }, 3000);

      typingTimeouts.set(socket.id, timeout);
    } catch (error) {
      console.error("Error in user-typing handler:", error);
    }
  });

  // Handle user stopped typing
  socket.on("user-stopped-typing", ({ roomId }) => {
    try {
      const activeRoom = activeRooms.get(roomId);
      if (!activeRoom) return;

      const user = activeRoom.users.get(socket.id);
      if (!user) return;

      // Clear any existing timeout for this user
      if (typingTimeouts.has(socket.id)) {
        clearTimeout(typingTimeouts.get(socket.id));
        typingTimeouts.delete(socket.id);
      }

      // Broadcast to everyone except the sender that this user stopped typing
      socket.to(roomId).emit("typing-indicator", {
        userId: user.id,
        userName: user.name,
        isTyping: false,
      });
    } catch (error) {
      console.error("Error in user-stopped-typing handler:", error);
    }
  });

  // Handle chat info updates
  socket.on("update-chat-info", async ({ roomId, chatInfo }) => {
    try {
      const activeRoom = activeRooms.get(roomId);
      if (!activeRoom) return;

      // Update the chat info in memory
      activeRoom.chatInfo = {
        ...activeRoom.chatInfo,
        ...chatInfo,
      };

      // Update in Firestore
      await updateRoom(roomId, {
        title: chatInfo.title,
        description: chatInfo.description,
      });

      // Broadcast the updated chat info to all users in the room
      io.to(roomId).emit("chat-info-updated", activeRoom.chatInfo);
    } catch (error) {
      console.error("Error updating chat info:", error);
      socket.emit("error", { message: "Failed to update chat info" });
    }
  });

  // Handle AI request using OpenAI API
  socket.on("request-ai-response", async ({ roomId, prompt, messageId }) => {
    try {
      const activeRoom = activeRooms.get(roomId);
      if (!activeRoom) {
        socket.emit("error", { message: "Room not found" });
        return;
      }

      // Create a placeholder message to show "AI is typing..."
      const typingMessage = {
        id: uuidv4(),
        userId: "ai",
        userName: "CollabGPT",
        userPhotoURL: null,
        content: "...",
        role: "assistant",
        timestamp: new Date(),
        isTyping: true,
      };

      // Send typing indicator to everyone
      io.to(roomId).emit("ai-typing", typingMessage);

      // Get room data from Firestore for context
      const roomData = await getRoom(roomId);

      // Extract previous messages for context (last 10 messages)
      const contextMessages = roomData.messages.slice(-10).map((msg) => ({
        role: msg.role,
        content: msg.content,
      }));

      // Generate AI response using OpenAI
      const aiResponseContent = await generateResponse(prompt, contextMessages);

      // Create the final AI response message
      const aiResponse = {
        id: typingMessage.id, // Use the same ID to replace the typing indicator
        userId: "ai",
        userName: "CollabGPT",
        userPhotoURL: null,
        content: aiResponseContent,
        role: "assistant",
        timestamp: new Date(),
      };

      // Store AI message in Firestore
      await saveMessage(roomId, aiResponse);

      // Broadcast AI response to everyone in the room
      io.to(roomId).emit("new-message", aiResponse);
    } catch (error) {
      console.error("Error generating AI response:", error);

      // Send error message
      const errorMessage = {
        id: uuidv4(),
        userId: "ai",
        userName: "CollabGPT",
        userPhotoURL: null,
        content:
          "Sorry, I couldn't generate a response at this time. Please try again later.",
        role: "assistant",
        timestamp: new Date(),
        isError: true,
      };

      io.to(roomId).emit("new-message", errorMessage);
    }
  });

  // Handle user leave
  socket.on("disconnect", () => {
    console.log(`User disconnected: ${socket.id}`);

    // Clear any typing timeouts for this user
    if (typingTimeouts.has(socket.id)) {
      clearTimeout(typingTimeouts.get(socket.id));
      typingTimeouts.delete(socket.id);
    }

    // Find and remove user from all active rooms they were in
    activeRooms.forEach((roomData, roomId) => {
      if (roomData.users.has(socket.id)) {
        const user = roomData.users.get(socket.id);
        roomData.users.delete(socket.id);

        // Notify others in the room
        io.to(roomId).emit("user-left", {
          userId: user.id,
          socketId: socket.id,
          users: Array.from(roomData.users.values()),
        });

        // Only remove room from memory if no active users and not in joinedRooms
        if (roomData.users.size === 0 && !joinedRooms.has(roomId)) {
          activeRooms.delete(roomId);
          console.log(`Room ${roomId} removed from active rooms (no users)`);
        }
      }
    });

    // Clear the joinedRooms set
    joinedRooms.clear();
  });

  // Handle user deleting a chat
  socket.on("user-deleted-chat", async ({ userId, roomId }) => {
    console.log(`Socket event: User ${userId} deleted chat ${roomId}`);

    // Get the active room if it exists
    const activeRoom = activeRooms.get(roomId);
    if (!activeRoom) return;

    // Find all socket IDs for this user ID
    const userSocketIds = [];
    activeRoom.users.forEach((user, socketId) => {
      if (user.id === userId) {
        userSocketIds.push(socketId);
      }
    });

    // Remove the user from the active room and notify other participants
    userSocketIds.forEach((socketId) => {
      if (activeRoom.users.has(socketId)) {
        const user = activeRoom.users.get(socketId);
        activeRoom.users.delete(socketId);

        // Notify others in the room that this user has left
        io.to(roomId).emit("user-left", {
          userId: user.id,
          socketId,
          users: Array.from(activeRoom.users.values()),
          reason: "deleted-chat",
        });
      }
    });

    // Update the main room record in Firestore if needed
    try {
      const { db } = require("./services/firebase");
      const roomRef = db.collection("rooms").doc(roomId);
      const roomDoc = await roomRef.get();

      if (roomDoc.exists) {
        const roomData = roomDoc.data();

        // If user was in participants, update the count
        if (roomData.participants && roomData.participants[userId]) {
          await roomRef.update({
            [`participants.${userId}`]: null, // Set to null instead of deleting to maintain history
            participantCount: Math.max(0, roomData.participantCount - 1),
            updatedAt: new Date(),
          });

          console.log(
            `Updated participation record for user ${userId} in room ${roomId}`
          );
        }
      }
    } catch (error) {
      console.error(
        `Error updating room record after user ${userId} deleted chat ${roomId}:`,
        error
      );
    }
  });
});

// Create a new room
app.post("/api/rooms", async (req, res) => {
  try {
    const roomId = uuidv4();
    const user = req.body.user || { uid: "system" };

    // Create room in Firestore with default values
    await createRoom(user, {
      roomId,
      title: "New Conversation",
      description: "Start typing to chat with AI and collaborators",
    });

    // Initialize in-memory cache
    activeRooms.set(roomId, {
      users: new Map(),
      chatInfo: {
        title: "New Conversation",
        description: "",
        createdAt: new Date(),
      },
      messages: [], // Explicitly initialize with empty messages array
    });

    res.json({ roomId });
  } catch (error) {
    console.error("Error creating room:", error);
    res.status(500).json({ error: "Failed to create room" });
  }
});
app.get("/", async (req, res) => {
  try {
    console.log(io);
  } catch (error) {
    console.error("Error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});
// Add a new API endpoint to get user's chat history
app.get("/api/users/:userId/chats", async (req, res) => {
  try {
    const { userId } = req.params;
    const limit = req.query.limit ? parseInt(req.query.limit) : 20;

    // Validate authentication (should be replaced with proper auth middleware)
    if (!userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    // Get user's chat history from firestore service
    const chatHistory = await getUserChatHistory(userId, limit);

    // Sort by lastAccessTime (most recently accessed first)
    chatHistory.sort((a, b) => {
      return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
    });

    res.json({ chats: chatHistory });
  } catch (error) {
    console.error("Error getting user chats:", error);
    res.status(500).json({ error: "Failed to get user chats" });
  }
});

// Add an API endpoint to get room collaborators
app.get("/api/rooms/:roomId/collaborators", async (req, res) => {
  try {
    const { roomId } = req.params;

    if (!roomId) {
      return res.status(400).json({ error: "Room ID is required" });
    }

    const collaborators = await getRoomCollaborators(roomId);
    res.json({ collaborators });
  } catch (error) {
    console.error("Error getting room collaborators:", error);
    res.status(500).json({ error: "Failed to get collaborators" });
  }
});

// Check if room exists
app.get("/api/rooms/:roomId", async (req, res) => {
  const { roomId } = req.params;

  try {
    // Check if room is already in memory
    if (activeRooms.has(roomId)) {
      res.json({ exists: true });
      return;
    }

    // Otherwise check in Firestore
    const roomData = await getRoom(roomId);

    // Ensure messages are sorted by timestamp
    if (roomData.messages) {
      roomData.messages.sort((a, b) => {
        const timeA =
          a.timestamp instanceof Date ? a.timestamp : new Date(a.timestamp);
        const timeB =
          b.timestamp instanceof Date ? b.timestamp : new Date(b.timestamp);
        return timeA.getTime() - timeB.getTime();
      });
    }

    res.json({ exists: true, title: roomData.title });
  } catch (error) {
    // Room doesn't exist
    res.json({ exists: false });
  }
});

// Add a DELETE endpoint to remove a chat from user's history
app.delete("/api/users/:userId/chats/:roomId", async (req, res) => {
  try {
    const { userId, roomId } = req.params;

    console.log(
      `Received request to delete room ${roomId} from history of user ${userId}`
    );

    if (!userId || !roomId) {
      console.log("Missing userId or roomId");
      return res
        .status(400)
        .json({ error: "User ID and Room ID are required" });
    }

    // Import the db reference directly to ensure we can access the collection
    const { db } = require("./services/firebase");

    try {
      // Direct Firestore operation for maximum reliability
      const userRoomRef = db
        .collection("users")
        .doc(userId)
        .collection("rooms")
        .doc(roomId);

      // Check if document exists
      const doc = await userRoomRef.get();
      if (!doc.exists) {
        console.log(`Chat ${roomId} not found in user ${userId}'s history`);
        return res
          .status(404)
          .json({ error: "Chat not found in user history" });
      }

      // Delete the document
      await userRoomRef.delete();

      console.log(
        `Successfully deleted room ${roomId} from user ${userId}'s history`
      );
      res.json({ success: true, message: "Chat removed from history" });
    } catch (firestoreError) {
      console.error(`Firestore error deleting chat:`, firestoreError);
      throw firestoreError;
    }
  } catch (error) {
    console.error("Error deleting chat from user history:", error);
    res
      .status(500)
      .json({ error: "Failed to delete chat", details: error.message });
  }
});

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`CORS allowed origins: ${corsOptions.origin.join(", ")}`);
});
