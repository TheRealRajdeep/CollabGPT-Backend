const { db } = require("./firebase.js");
const { v4: uuidv4 } = require("uuid");

/**
 * Create or update user profile in Firestore
 * @param {Object} user - User object from Firebase Auth
 * @returns {Promise<Object>} - The created/updated user document
 */
async function saveUser(user) {
  if (!user || !user.uid) {
    throw new Error("Invalid user object");
  }

  const userData = {
    uid: user.uid,
    displayName: user.displayName || "Anonymous",
    email: user.email || null,
    photoURL: user.photoURL || null,
    lastSeen: new Date(),
    createdAt: new Date(),
  };

  try {
    // Set with merge option to update if exists or create if not
    await db.collection("users").doc(user.uid).set(userData, { merge: true });
    return userData;
  } catch (error) {
    console.error("Error saving user to Firestore:", error);
    throw error;
  }
}

/**
 * Create a new chat room
 * @param {Object} creator - User who created the room
 * @param {Object} options - Room options like title
 * @returns {Promise<Object>} - The created room document
 */
async function createRoom(creator, options = {}) {
  if (!creator || !creator.uid) {
    throw new Error("Invalid creator user");
  }

  const roomId = options.roomId || uuidv4();

  // Initialize participants with the creator
  const participants = {
    [creator.uid]: {
      role: "admin",
      joinedAt: new Date(),
      displayName: creator.displayName || "Anonymous",
      photoURL: creator.photoURL || null,
    },
  };

  const roomData = {
    id: roomId,
    title: options.title || "New Conversation",
    description: options.description || "",
    createdAt: new Date(),
    updatedAt: new Date(),
    createdBy: creator.uid,
    participants,
    participantCount: 1,
    messageCount: 0,
    lastMessage: null,
  };

  try {
    await db.collection("rooms").doc(roomId).set(roomData);
    return { roomId, ...roomData };
  } catch (error) {
    console.error("Error creating room in Firestore:", error);
    throw error;
  }
}

/**
 * Add a user to a chat room
 * @param {string} roomId - Room ID
 * @param {Object} user - User to add
 * @returns {Promise<boolean>} - Success status
 */
async function addUserToRoom(roomId, user) {
  if (!roomId || !user || !user.uid) {
    throw new Error("Invalid room ID or user");
  }

  try {
    const roomRef = db.collection("rooms").doc(roomId);

    // Get current room data
    const roomDoc = await roomRef.get();
    if (!roomDoc.exists) {
      throw new Error(`Room ${roomId} not found`);
    }

    // Update room participants
    return await roomRef.update({
      [`participants.${user.uid}`]: {
        role: "member",
        joinedAt: new Date(),
        displayName: user.displayName || "Anonymous",
        photoURL: user.photoURL || null,
      },
      participantCount: roomDoc.data().participantCount + 1,
      updatedAt: new Date(),
    });
  } catch (error) {
    console.error(`Error adding user ${user.uid} to room ${roomId}:`, error);
    throw error;
  }
}

/**
 * Save a chat message to Firestore
 * @param {string} roomId - Room ID
 * @param {Object} message - Message object
 * @returns {Promise<Object>} - The saved message
 */
async function saveMessage(roomId, message) {
  if (!roomId || !message || !message.content) {
    throw new Error("Invalid room ID or message");
  }

  const messageId = message.id || uuidv4();
  const timestamp = new Date();

  // Prepare message data
  const messageData = {
    id: messageId,
    content: message.content,
    role: message.role || "user",
    userId: message.userId || "system",
    userName: message.userName || "System",
    userPhotoURL: message.userPhotoURL || null,
    timestamp,
    createdAt: timestamp,
  };

  try {
    // Transaction to save message and update room metadata
    await db.runTransaction(async (transaction) => {
      const roomRef = db.collection("rooms").doc(roomId);
      const messageRef = roomRef.collection("messages").doc(messageId);

      // Get current room data
      const roomDoc = await transaction.get(roomRef);
      if (!roomDoc.exists) {
        throw new Error(`Room ${roomId} not found`);
      }

      // Update message count and last message in room
      transaction.update(roomRef, {
        messageCount: roomDoc.data().messageCount + 1,
        lastMessage: {
          content: messageData.content.substring(0, 100),
          timestamp,
          userId: messageData.userId,
          userName: messageData.userName,
        },
        updatedAt: timestamp,
      });

      // Save the message
      transaction.set(messageRef, messageData);
    });

    return { id: messageId, ...messageData };
  } catch (error) {
    console.error(`Error saving message to room ${roomId}:`, error);
    throw error;
  }
}

/**
 * Get room details with optional message history
 * @param {string} roomId - Room ID
 * @param {Object} options - Options like message limit
 * @returns {Promise<Object>} - Room data with messages
 */
async function getRoom(roomId, options = { messageLimit: 100 }) {
  if (!roomId) {
    throw new Error("Invalid room ID");
  }

  try {
    // Get room document
    const roomDoc = await db.collection("rooms").doc(roomId).get();
    if (!roomDoc.exists) {
      throw new Error(`Room ${roomId} not found`);
    }

    const roomData = roomDoc.data();
    // Get messages sorted by timestamp
    const messagesSnapshot = await db
      .collection("rooms")
      .doc(roomId)
      .collection("messages")
      .orderBy("timestamp", "asc") // Explicitly order by timestamp ascending
      .limit(options.messageLimit || 100)
      .get();

    // Map document data and convert timestamps to JavaScript Date objects
    const messages = messagesSnapshot.docs.map((doc) => {
      const data = doc.data();
      return {
        ...data,
        timestamp: data.timestamp?.toDate() || new Date(),
        createdAt: data.createdAt?.toDate() || new Date(),
      };
    });

    return {
      ...roomData,
      messages,
    };
  } catch (error) {
    console.error(`Error getting room ${roomId}:`, error);
    throw error;
  }
}

/**
 * Update room information
 * @param {string} roomId - Room ID
 * @param {Object} data - Data to update
 * @returns {Promise<boolean>} - Success status
 */
async function updateRoom(roomId, data) {
  if (!roomId || !data) {
    throw new Error("Invalid room ID or data");
  }

  // Remove disallowed fields
  const safeData = { ...data };
  delete safeData.id;
  delete safeData.createdAt;
  delete safeData.createdBy;
  delete safeData.participants;
  delete safeData.participantCount;
  delete safeData.messageCount;

  // Add update timestamp
  safeData.updatedAt = new Date();

  try {
    await db.collection("rooms").doc(roomId).update(safeData);
    return true;
  } catch (error) {
    console.error(`Error updating room ${roomId}:`, error);
    throw error;
  }
}

/**
 * List rooms for a user
 * @param {string} userId - User ID
 * @param {number} limit - Max number of rooms to fetch
 * @returns {Promise<Array>} - Array of room documents
 */
async function getUserRooms(userId, limit = 50) {
  if (!userId) {
    throw new Error("Invalid user ID");
  }

  try {
    // Query rooms where user is a participant
    const roomsSnapshot = await db
      .collection("rooms")
      .where(`participants.${userId}`, "!=", null)
      .orderBy(`participants.${userId}.joinedAt`, "desc")
      .limit(limit)
      .get();

    return roomsSnapshot.docs.map((doc) => doc.data());
  } catch (error) {
    console.error(`Error getting rooms for user ${userId}:`, error);
    throw error;
  }
}

/**
 * Update user's last access time for a room
 * @param {string} userId - User ID
 * @param {string} roomId - Room ID
 * @returns {Promise<boolean>} - Success status
 */
async function updateUserRoomAccess(userId, roomId) {
  if (!userId || !roomId) {
    throw new Error("User ID and Room ID are required");
  }

  try {
    const roomRef = db.collection("rooms").doc(roomId);
    await roomRef.update({
      [`participants.${userId}.lastAccessTime`]: new Date(),
    });

    // Also update user's rooms collection for quicker lookup
    const userRoomRef = db
      .collection("users")
      .doc(userId)
      .collection("rooms")
      .doc(roomId);
    await userRoomRef.set(
      {
        roomId,
        lastAccessTime: new Date(),
      },
      { merge: true }
    );

    return true;
  } catch (error) {
    console.error(
      `Error updating access for user ${userId} in room ${roomId}:`,
      error
    );
    throw error;
  }
}

/**
 * Get room participants/collaborators
 * @param {string} roomId - Room ID
 * @returns {Promise<Array>} - Array of collaborator objects
 */
async function getRoomCollaborators(roomId) {
  if (!roomId) {
    throw new Error("Room ID is required");
  }

  try {
    const roomDoc = await db.collection("rooms").doc(roomId).get();

    if (!roomDoc.exists) {
      throw new Error(`Room ${roomId} not found`);
    }

    const data = roomDoc.data();

    if (!data.participants) {
      return [];
    }

    // Convert participants map to array of user objects
    return Object.entries(data.participants).map(([userId, userData]) => ({
      id: userId,
      name: userData.displayName,
      photoURL: userData.photoURL,
      role: userData.role || "member",
      joinedAt: userData.joinedAt?.toDate() || new Date(),
    }));
  } catch (error) {
    console.error(`Error getting collaborators for room ${roomId}:`, error);
    throw error;
  }
}

/**
 * Track user's room history
 * @param {string} userId - User ID
 * @param {string} roomId - Room ID
 * @param {Object} roomData - Basic room data to store
 * @returns {Promise<void>}
 */
async function trackUserRoomHistory(userId, roomId, roomData = {}) {
  if (!userId || !roomId) {
    throw new Error("User ID and Room ID are required");
  }

  try {
    // Get the most up-to-date room info
    let title = roomData.title || "New Conversation";
    let lastMessage = roomData.lastMessage || null;
    let createdAt = roomData.createdAt || new Date();

    try {
      // Try to get the latest room data from Firestore
      const roomDoc = await db.collection("rooms").doc(roomId).get();
      if (roomDoc.exists) {
        const currentRoomData = roomDoc.data();
        title = currentRoomData.title || title;
        lastMessage = currentRoomData.lastMessage || lastMessage;
        createdAt = currentRoomData.createdAt?.toDate() || createdAt;
      }
    } catch (error) {
      console.warn(`Unable to fetch latest room data for ${roomId}:`, error);
      // Continue with the data we have
    }

    // Check if this room already exists in the user's history
    const userRoomRef = db
      .collection("users")
      .doc(userId)
      .collection("rooms")
      .doc(roomId);

    const existingDoc = await userRoomRef.get();
    const lastAccessTime = new Date();

    if (existingDoc.exists) {
      // If the room exists in history, just update the lastAccessTime
      await userRoomRef.update({
        lastAccessTime,
        title: title, // Update title in case it changed
        // Only update lastMessage if it exists and is newer
        ...(lastMessage
          ? {
              lastMessage: {
                ...lastMessage,
                timestamp:
                  lastMessage.timestamp instanceof Date
                    ? lastMessage.timestamp
                    : new Date(lastMessage.timestamp),
              },
            }
          : {}),
      });
    } else {
      // If it's a new room in the user's history, add with all info
      await userRoomRef.set({
        roomId,
        title,
        lastMessage: lastMessage
          ? {
              ...lastMessage,
              timestamp:
                lastMessage.timestamp instanceof Date
                  ? lastMessage.timestamp
                  : new Date(lastMessage.timestamp),
            }
          : null,
        lastAccessTime,
        createdAt: createdAt instanceof Date ? createdAt : new Date(createdAt),
      });
    }

    console.log(`Room ${roomId} tracked in history for user ${userId}`);
  } catch (error) {
    console.error(`Error tracking room history for user ${userId}:`, error);
    // Don't throw to prevent disrupting the main flow
  }
}

/**
 * Get user's chat history
 * @param {string} userId - User ID
 * @param {number} limit - Maximum number of rooms to return
 * @returns {Promise<Array>} - Array of room summary objects
 */
async function getUserChatHistory(userId, limit = 20) {
  if (!userId) {
    throw new Error("User ID is required");
  }

  try {
    const userRoomsRef = db.collection("users").doc(userId).collection("rooms");
    const snapshot = await userRoomsRef
      .orderBy("lastAccessTime", "desc")
      .limit(limit)
      .get();

    if (snapshot.empty) {
      return [];
    }

    // Helper function to safely convert Firestore timestamps to JS Date objects
    const convertTimestamp = (timestamp) => {
      if (!timestamp) return new Date();
      return timestamp.toDate ? timestamp.toDate() : new Date(timestamp);
    };

    // Get room details for each room in the history
    const roomPromises = snapshot.docs.map(async (doc) => {
      const roomId = doc.id;
      const userRoomData = doc.data(); // Get the user-specific room data first

      try {
        // Try to get full room data
        const roomRef = db.collection("rooms").doc(roomId);
        const roomDoc = await roomRef.get();

        if (!roomDoc.exists) {
          // Return the user-specific data if the room doesn't exist anymore
          return {
            id: roomId,
            title: userRoomData.title || "Deleted Chat",
            lastMessage: userRoomData.lastMessage
              ? {
                  ...userRoomData.lastMessage,
                  timestamp: userRoomData.lastMessage.timestamp
                    ? convertTimestamp(userRoomData.lastMessage.timestamp)
                    : new Date(),
                }
              : null,
            updatedAt: convertTimestamp(userRoomData.lastAccessTime),
            createdAt: convertTimestamp(userRoomData.createdAt),
            participantCount: 0,
            messageCount: 0,
          };
        }

        const roomData = roomDoc.data();
        return {
          id: roomId,
          title: roomData.title || userRoomData.title || "Untitled Chat",
          lastMessage: roomData.lastMessage
            ? {
                ...roomData.lastMessage,
                timestamp: convertTimestamp(roomData.lastMessage.timestamp),
              }
            : null,
          updatedAt: convertTimestamp(roomData.updatedAt),
          createdAt: convertTimestamp(roomData.createdAt),
          participantCount: roomData.participantCount || 0,
          messageCount: roomData.messageCount || 0,
          lastAccessed: convertTimestamp(userRoomData.lastAccessTime),
        };
      } catch (error) {
        console.error(`Error fetching room ${roomId}:`, error);
        // Return a basic object if we can't get the full room data
        return {
          id: roomId,
          title: userRoomData.title || "Unknown Chat",
          updatedAt: convertTimestamp(userRoomData.lastAccessTime),
          createdAt: convertTimestamp(userRoomData.createdAt),
        };
      }
    });

    const rooms = await Promise.all(roomPromises);
    return rooms.filter(Boolean); // Remove null entries
  } catch (error) {
    console.error(`Error getting chat history for user ${userId}:`, error);
    throw error;
  }
}

/**
 * Remove a chat from user's history
 * @param {string} userId - User ID
 * @param {string} roomId - Room ID to remove
 * @returns {Promise<boolean>} - Success status
 */
async function removeUserChat(userId, roomId) {
  if (!userId || !roomId) {
    throw new Error("User ID and Room ID are required");
  }

  try {
    console.log(`Removing room ${roomId} from history for user ${userId}`);

    // Get DB reference
    const { db } = require("./firebase");

    // Get reference to the user's room document
    const userRoomRef = db
      .collection("users")
      .doc(userId)
      .collection("rooms")
      .doc(roomId);

    // Try to delete without checking existence first (more efficient)
    await userRoomRef.delete();

    console.log(
      `Successfully removed room ${roomId} from history for user ${userId}`
    );

    // Also update the main rooms collection to reflect this user has left
    try {
      const roomRef = db.collection("rooms").doc(roomId);

      // Get the room document to check if it exists
      const roomDoc = await roomRef.get();

      if (roomDoc.exists) {
        // Update the participants field to remove this user
        const roomData = roomDoc.data();

        if (roomData.participants && roomData.participants[userId]) {
          // Remove the user from participants
          await roomRef.update({
            [`participants.${userId}`]: null,
            participantCount:
              roomData.participantCount > 0 ? roomData.participantCount - 1 : 0,
            updatedAt: new Date(),
          });

          console.log(
            `Removed user ${userId} from room ${roomId} participants`
          );
        }
      }
    } catch (roomUpdateError) {
      // Don't fail the whole operation if this part fails
      console.warn(
        `Could not update main room record: ${roomUpdateError.message}`
      );
    }

    return true;
  } catch (error) {
    console.error(
      `Error removing room ${roomId} from history for user ${userId}:`,
      error
    );

    // Check if this is a not-found error, which we can ignore
    if (error.code === "not-found") {
      console.log(`Room ${roomId} was already not in user ${userId}'s history`);
      return true;
    }

    throw error;
  }
}

module.exports = {
  saveUser,
  createRoom,
  addUserToRoom,
  saveMessage,
  getRoom,
  updateRoom,
  getUserRooms,
  updateUserRoomAccess,
  getRoomCollaborators,
  trackUserRoomHistory,
  getUserChatHistory,
  removeUserChat, // Add the new function
};
