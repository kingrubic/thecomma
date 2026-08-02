import { v } from "convex/values";
import { internalMutation, mutation, query } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";

const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7;

async function hashPassword(password: string, salt: string) {
  const encoded = new TextEncoder().encode(`${salt}:${password}`);
  const digest = await crypto.subtle.digest("SHA-256", encoded);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function makeToken() {
  const random = new Uint8Array(24);
  crypto.getRandomValues(random);
  return `${Date.now().toString(36)}-${Array.from(random)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}`;
}

async function getSession(ctx: QueryCtx | MutationCtx, token: string) {
  const session = await ctx.db
    .query("adminSessions")
    .withIndex("by_token", (q) => q.eq("token", token))
    .first();

  if (!session || session.expiresAt <= Date.now()) return null;

  const user = await ctx.db.get(session.userId);
  if (!user || !user.isActive) return null;

  return { session, user };
}

export async function requireAdminSession(
  ctx: QueryCtx | MutationCtx,
  token: string,
  options: { allowPasswordChange?: boolean } = {},
) {
  const session = await getSession(ctx, token);
  if (!session) throw new Error("Unauthorized.");
  if (session.user.mustChangePassword && !options.allowPasswordChange) {
    throw new Error("Password change required.");
  }
  return session;
}

export const setupStatus = query({
  args: {},
  handler: async (ctx) => {
    const admin = await ctx.db.query("adminUsers").first();
    return { configured: Boolean(admin) };
  },
});

export const seedDefaultAdmin = mutation({
  args: {
    username: v.string(),
    password: v.string(),
    name: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db.query("adminUsers").first();
    if (existing) return { created: false, username: existing.username };

    const username = args.username.trim().toLowerCase();
    const password = args.password;
    if (!/^[a-z0-9][a-z0-9._-]{2,31}$/.test(username)) {
      throw new Error("Username must be 3-32 lowercase characters.");
    }
    if (password.length < 8) {
      throw new Error("Password must be at least 8 characters.");
    }

    const now = Date.now();
    const salt = makeToken();
    const passwordHash = await hashPassword(password, salt);
    await ctx.db.insert("adminUsers", {
      username,
      name: args.name?.trim() || "The Comma Editor",
      role: "admin",
      passwordHash,
      passwordSalt: salt,
      mustChangePassword: true,
      isActive: true,
      createdAt: now,
      updatedAt: now,
    });

    return { created: true, username };
  },
});

// Local operator recovery: reset the shared editor password while preserving
// the first-login password-change gate. This is intentionally internal so it
// cannot be invoked through the public HTTP API.
export const resetAdminPassword = internalMutation({
  args: { username: v.string(), password: v.string() },
  handler: async (ctx, args) => {
    const username = args.username.trim().toLowerCase();
    const user = await ctx.db
      .query("adminUsers")
      .withIndex("by_username", (q) => q.eq("username", username))
      .first();
    if (!user) throw new Error("Admin user not found.");
    if (args.password.length < 8) throw new Error("Password must be at least 8 characters.");
    const salt = makeToken();
    const passwordHash = await hashPassword(args.password, salt);
    await ctx.db.patch(user._id, {
      passwordSalt: salt,
      passwordHash,
      mustChangePassword: true,
      updatedAt: Date.now(),
    });
    const sessions = await ctx.db
      .query("adminSessions")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .collect();
    for (const session of sessions) await ctx.db.delete(session._id);
    return { username: user.username, mustChangePassword: true };
  },
});

export const login = mutation({
  args: { username: v.string(), password: v.string() },
  handler: async (ctx, args) => {
    const username = args.username.trim().toLowerCase();
    const user = await ctx.db
      .query("adminUsers")
      .withIndex("by_username", (q) => q.eq("username", username))
      .first();

    if (!user || !user.isActive) throw new Error("Invalid credentials.");
    const passwordHash = await hashPassword(args.password, user.passwordSalt);
    if (passwordHash !== user.passwordHash) throw new Error("Invalid credentials.");

    const now = Date.now();
    const token = makeToken();
    await ctx.db.insert("adminSessions", {
      userId: user._id,
      token,
      createdAt: now,
      lastSeenAt: now,
      expiresAt: now + SESSION_TTL_MS,
    });

    return {
      token,
      user: {
        id: user._id,
        username: user.username,
        name: user.name,
        role: user.role,
        mustChangePassword: user.mustChangePassword === true,
      },
    };
  },
});

export const me = query({
  args: { token: v.string() },
  handler: async (ctx, args) => {
    const session = await getSession(ctx, args.token);
    if (!session) return null;
    return {
      id: session.user._id,
      username: session.user.username,
      name: session.user.name,
      role: session.user.role,
      mustChangePassword: session.user.mustChangePassword === true,
    };
  },
});

export const logout = mutation({
  args: { token: v.string() },
  handler: async (ctx, args) => {
    const session = await ctx.db
      .query("adminSessions")
      .withIndex("by_token", (q) => q.eq("token", args.token))
      .first();
    if (session) await ctx.db.delete(session._id);
    return true;
  },
});

export const changePassword = mutation({
  args: {
    token: v.string(),
    currentPassword: v.string(),
    newPassword: v.string(),
  },
  handler: async (ctx, args) => {
    const session = await requireAdminSession(ctx, args.token, {
      allowPasswordChange: true,
    });
    if (args.newPassword.length < 8) {
      throw new Error("New password must be at least 8 characters.");
    }
    if (args.newPassword === args.currentPassword) {
      throw new Error("New password must be different from the current password.");
    }
    const currentHash = await hashPassword(
      args.currentPassword,
      session.user.passwordSalt,
    );
    if (currentHash !== session.user.passwordHash) {
      throw new Error("Current password is incorrect.");
    }

    const salt = makeToken();
    const passwordHash = await hashPassword(args.newPassword, salt);
    await ctx.db.patch(session.user._id, {
      passwordSalt: salt,
      passwordHash,
      mustChangePassword: false,
      updatedAt: Date.now(),
    });

    const sessions = await ctx.db
      .query("adminSessions")
      .withIndex("by_user", (q) => q.eq("userId", session.user._id))
      .collect();
    for (const other of sessions) {
      if (other._id !== session.session._id) await ctx.db.delete(other._id);
    }
    return true;
  },
});
