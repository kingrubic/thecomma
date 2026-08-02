import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  adminUsers: defineTable({
    username: v.string(),
    name: v.string(),
    role: v.literal("admin"),
    passwordHash: v.string(),
    passwordSalt: v.string(),
    mustChangePassword: v.optional(v.boolean()),
    isActive: v.boolean(),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_username", ["username"]),

  adminSessions: defineTable({
    userId: v.id("adminUsers"),
    token: v.string(),
    createdAt: v.number(),
    lastSeenAt: v.number(),
    expiresAt: v.number(),
  })
    .index("by_token", ["token"])
    .index("by_user", ["userId"]),

  categories: defineTable({
    name: v.string(),
    normalizedName: v.string(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_normalized_name", ["normalizedName"])
    .index("by_updated", ["updatedAt"]),

  posts: defineTable({
    title: v.string(),
    slug: v.string(),
    excerpt: v.string(),
    content: v.string(),
    focusKeyword: v.optional(v.string()),
    coverImage: v.optional(v.string()),
    category: v.string(),
    tags: v.array(v.string()),
    status: v.union(
      v.literal("draft"),
      v.literal("published"),
      v.literal("scheduled"),
    ),
    author: v.string(),
    agentManaged: v.optional(v.boolean()),
    publishedAt: v.optional(v.number()),
    scheduledAt: v.optional(v.number()),
    updatedAt: v.number(),
  })
    .index("by_slug", ["slug"])
    .index("by_status", ["status"])
    .index("by_category", ["category"]),
});
