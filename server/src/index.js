import crypto from "node:crypto";
import dotenv from "dotenv";
import express from "express";
import cors from "cors";
import jwt from "jsonwebtoken";
import { createServer } from "node:http";
import { Server } from "socket.io";
import { createAdapter } from "@socket.io/redis-adapter";
import { createClient } from "redis";

dotenv.config();

const PORT = Number(process.env.PORT || 4000);
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || "*";
const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
const DISCORD_REDIRECT_URI = process.env.DISCORD_REDIRECT_URI || `http://localhost:${PORT}/auth/discord/callback`;
const JWT_SECRET = process.env.JWT_SECRET || "replace-me-before-production";
const SESSION_TTL_SECONDS = Number(process.env.SESSION_TTL_SECONDS || 60 * 60 * 24 * 7);
const OAUTH_STATE_TTL_SECONDS = Number(process.env.OAUTH_STATE_TTL_SECONDS || 60 * 10);
const REDIS_URL = process.env.REDIS_URL || "";
const ALLOWED_RETURN_PREFIXES = (process.env.ALLOWED_RETURN_PREFIXES || "ota-connect://auth,exp://,ota-connect-mobile://auth,http://localhost")
  .split(",")
  .map((prefix) => prefix.trim())
  .filter(Boolean);

const DEFAULT_ICE_SERVERS = [{ urls: "stun:stun.l.google.com:19302" }];

function parseIceServers() {
  const rawJson = process.env.RTC_ICE_SERVERS_JSON?.trim();
  if (rawJson) {
    try {
      const parsed = JSON.parse(rawJson);
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    } catch (error) {
      console.warn("Failed to parse RTC_ICE_SERVERS_JSON:", error.message);
    }
  }

  const turnUrls = (process.env.TURN_URLS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  if (turnUrls.length > 0) {
    return [
      ...DEFAULT_ICE_SERVERS,
      {
        urls: turnUrls,
        username: process.env.TURN_USERNAME || "",
        credential: process.env.TURN_CREDENTIAL || ""
      }
    ];
  }

  return DEFAULT_ICE_SERVERS;
}

const RTC_ICE_SERVERS = parseIceServers();

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: CLIENT_ORIGIN === "*" ? true : CLIENT_ORIGIN.split(","),
    credentials: true
  }
});

let redisEnabled = false;

app.use(cors({ origin: CLIENT_ORIGIN === "*" ? true : CLIENT_ORIGIN.split(","), credentials: true }));
app.use(express.json());

function requireDiscordConfig(res) {
  if (!DISCORD_CLIENT_ID || !DISCORD_CLIENT_SECRET) {
    res.status(500).json({ error: "Discord OAuth is not configured." });
    return false;
  }
  return true;
}

function isAllowedReturnTo(returnTo) {
  return Boolean(returnTo) && ALLOWED_RETURN_PREFIXES.some((prefix) => returnTo.startsWith(prefix));
}

function buildAvatarUrl(user) {
  if (!user.avatar) {
    const fallbackIndex = Number(BigInt(user.id) >> 22n) % 6;
    return `https://cdn.discordapp.com/embed/avatars/${fallbackIndex}.png`;
  }
  const ext = user.avatar.startsWith("a_") ? "gif" : "png";
  return `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.${ext}?size=128`;
}

function publicUser(discordUser) {
  return {
    discordId: discordUser.id,
    username: discordUser.global_name || discordUser.username,
    avatar: buildAvatarUrl(discordUser)
  };
}

function createSessionToken(user) {
  return jwt.sign(
    {
      sub: user.discordId,
      user
    },
    JWT_SECRET,
    {
      algorithm: "HS256",
      expiresIn: SESSION_TTL_SECONDS,
      issuer: "ota-connect",
      audience: "ota-connect-client",
      jwtid: crypto.randomUUID()
    }
  );
}

function authenticateToken(token) {
  if (!token) return null;
  try {
    const decoded = jwt.verify(token, JWT_SECRET, {
      algorithms: ["HS256"],
      issuer: "ota-connect",
      audience: "ota-connect-client"
    });
    return decoded.user || null;
  } catch {
    return null;
  }
}

function createOauthState(returnTo) {
  return jwt.sign(
    { returnTo },
    JWT_SECRET,
    {
      algorithm: "HS256",
      expiresIn: OAUTH_STATE_TTL_SECONDS,
      issuer: "ota-connect",
      audience: "ota-connect-oauth"
    }
  );
}

function verifyOauthState(state) {
  try {
    return jwt.verify(state, JWT_SECRET, {
      algorithms: ["HS256"],
      issuer: "ota-connect",
      audience: "ota-connect-oauth"
    });
  } catch {
    return null;
  }
}

async function socketsInRoom(roomId) {
  return io.in(roomId).fetchSockets();
}

async function voiceParticipants(roomId, excludeSocketId) {
  const sockets = await socketsInRoom(roomId);
  return sockets
    .filter((client) => client.data.voice && client.id !== excludeSocketId)
    .map((client) => ({
      socketId: client.id,
      user: client.data.user
    }));
}

async function roomUserCount(roomId) {
  const sockets = await socketsInRoom(roomId);
  return sockets.length;
}

async function removeClientFromRooms(socket) {
  if (!socket.data.roomId) return;
  const roomId = socket.data.roomId;
  const user = socket.data.user;

  if (socket.data.voice) {
    socket.to(roomId).emit("voice:user-left", {
      socketId: socket.id,
      user,
      timestamp: new Date().toISOString()
    });
  }

  socket.leave(roomId);
  socket.to(roomId).emit("room:user-left", {
    roomId,
    user,
    timestamp: new Date().toISOString()
  });

  socket.data.roomId = null;
  socket.data.voice = false;
}

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    redisEnabled,
    sessionTtlSeconds: SESSION_TTL_SECONDS
  });
});

app.get("/config", (_req, res) => {
  res.json({
    rtcIceServers: RTC_ICE_SERVERS,
    sessionTtlSeconds: SESSION_TTL_SECONDS
  });
});

app.get("/auth/discord", (req, res) => {
  if (!requireDiscordConfig(res)) return;

  const returnTo = String(req.query.returnTo || "");
  if (!isAllowedReturnTo(returnTo)) {
    res.status(400).send("Invalid returnTo URL.");
    return;
  }

  const params = new URLSearchParams({
    client_id: DISCORD_CLIENT_ID,
    redirect_uri: DISCORD_REDIRECT_URI,
    response_type: "code",
    scope: "identify",
    state: createOauthState(returnTo),
    prompt: "none"
  });

  res.redirect(`https://discord.com/oauth2/authorize?${params.toString()}`);
});

app.get("/auth/discord/callback", async (req, res) => {
  if (!requireDiscordConfig(res)) return;

  const code = String(req.query.code || "");
  const state = String(req.query.state || "");
  const stateRecord = verifyOauthState(state);

  if (!code || !stateRecord?.returnTo || !isAllowedReturnTo(stateRecord.returnTo)) {
    res.status(400).send("Invalid OAuth callback.");
    return;
  }

  try {
    const tokenResponse = await fetch("https://discord.com/api/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: DISCORD_CLIENT_ID,
        client_secret: DISCORD_CLIENT_SECRET,
        grant_type: "authorization_code",
        code,
        redirect_uri: DISCORD_REDIRECT_URI
      })
    });

    if (!tokenResponse.ok) {
      throw new Error(`Discord token exchange failed: ${await tokenResponse.text()}`);
    }

    const tokenJson = await tokenResponse.json();
    const userResponse = await fetch("https://discord.com/api/users/@me", {
      headers: { Authorization: `Bearer ${tokenJson.access_token}` }
    });

    if (!userResponse.ok) {
      throw new Error(`Discord user fetch failed: ${await userResponse.text()}`);
    }

    const user = publicUser(await userResponse.json());
    const sessionToken = createSessionToken(user);
    const redirectTarget = new URL(stateRecord.returnTo);
    redirectTarget.searchParams.set("token", sessionToken);

    res.redirect(redirectTarget.toString());
  } catch (error) {
    console.error(error);
    res.status(500).send("Discord login failed.");
  }
});

app.get("/me", (req, res) => {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const user = authenticateToken(token);

  if (!user) {
    res.status(401).json({ error: "Invalid session." });
    return;
  }

  res.json({ user });
});

io.use((socket, next) => {
  const user = authenticateToken(socket.handshake.auth?.token);

  if (!user) {
    next(new Error("Unauthorized"));
    return;
  }

  socket.data.user = user;
  socket.data.voice = false;
  next();
});

io.on("connection", (socket) => {
  socket.emit("session:user", socket.data.user);

  socket.on("room:join", async (rawRoomId, ack) => {
    const roomId = String(rawRoomId || "").trim().toUpperCase();
    if (!roomId) {
      ack?.({ ok: false, error: "Room ID is required." });
      return;
    }

    await removeClientFromRooms(socket);
    await socket.join(roomId);
    socket.data.roomId = roomId;

    const payload = { roomId, user: socket.data.user, timestamp: new Date().toISOString() };
    socket.emit("room:joined", payload);
    socket.to(roomId).emit("room:user-joined", payload);
    ack?.({ ok: true, roomId, userCount: await roomUserCount(roomId) });
  });

  socket.on("room:leave", async (_payload, ack) => {
    await removeClientFromRooms(socket);
    ack?.({ ok: true });
  });

  socket.on("message:send", (payload, ack) => {
    const roomId = socket.data.roomId;
    const text = String(payload?.message || "").trim();

    if (!roomId) {
      ack?.({ ok: false, error: "Join a room before sending messages." });
      return;
    }

    if (!text) {
      ack?.({ ok: false, error: "Message cannot be empty." });
      return;
    }

    const message = {
      id: crypto.randomUUID(),
      roomId,
      user: socket.data.user,
      message: text.slice(0, 2000),
      timestamp: new Date().toISOString()
    };

    io.to(roomId).emit("message:new", message);
    ack?.({ ok: true, message });
  });

  socket.on("typing:start", () => {
    if (socket.data.roomId) {
      socket.to(socket.data.roomId).emit("typing:update", { user: socket.data.user, typing: true });
    }
  });

  socket.on("typing:stop", () => {
    if (socket.data.roomId) {
      socket.to(socket.data.roomId).emit("typing:update", { user: socket.data.user, typing: false });
    }
  });

  socket.on("voice:join", async (_payload, ack) => {
    const roomId = socket.data.roomId;
    if (!roomId) {
      ack?.({ ok: false, error: "Join a room before starting voice." });
      return;
    }

    if (socket.data.voice) {
      ack?.({
        ok: true,
        self: { socketId: socket.id, user: socket.data.user },
        participants: await voiceParticipants(roomId, socket.id)
      });
      return;
    }

    socket.data.voice = true;
    const participant = { socketId: socket.id, user: socket.data.user };
    socket.to(roomId).emit("voice:user-joined", {
      ...participant,
      timestamp: new Date().toISOString()
    });
    ack?.({ ok: true, self: participant, participants: await voiceParticipants(roomId, socket.id) });
  });

  socket.on("voice:leave", (_payload, ack) => {
    const roomId = socket.data.roomId;
    if (roomId && socket.data.voice) {
      socket.data.voice = false;
      socket.to(roomId).emit("voice:user-left", {
        socketId: socket.id,
        user: socket.data.user,
        timestamp: new Date().toISOString()
      });
    }
    ack?.({ ok: true });
  });

  socket.on("voice:signal", async (payload) => {
    const roomId = socket.data.roomId;
    const targetSocketId = String(payload?.targetSocketId || "");
    if (!roomId || !socket.data.voice || !targetSocketId) return;

    const participants = await voiceParticipants(roomId);
    const targetInRoom = participants.some((client) => client.socketId === targetSocketId);
    if (!targetInRoom) return;

    socket.to(targetSocketId).emit("voice:signal", {
      fromSocketId: socket.id,
      fromUser: socket.data.user,
      signal: payload.signal
    });
  });

  socket.on("disconnect", () => {
    void removeClientFromRooms(socket);
  });
});

async function enableRedisAdapter() {
  if (!REDIS_URL) return;

  const pubClient = createClient({ url: REDIS_URL });
  const subClient = pubClient.duplicate();
  await Promise.all([pubClient.connect(), subClient.connect()]);
  io.adapter(createAdapter(pubClient, subClient));
  redisEnabled = true;
}

await enableRedisAdapter();

httpServer.listen(PORT, () => {
  console.log(`OTA Connect server running on http://localhost:${PORT}`);
});
