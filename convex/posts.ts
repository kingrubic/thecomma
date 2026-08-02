import { v } from "convex/values";
import {
  internalMutation,
  mutation,
  query,
  type MutationCtx,
} from "./_generated/server";
import { requireAdminSession } from "./adminAuth";

const status = v.union(
  v.literal("draft"),
  v.literal("published"),
  v.literal("scheduled"),
);

const postFields = {
  title: v.string(),
  slug: v.string(),
  excerpt: v.string(),
  content: v.string(),
  focusKeyword: v.optional(v.string()),
  coverImage: v.optional(v.string()),
  category: v.string(),
  tags: v.array(v.string()),
  status,
  author: v.string(),
  publishedAt: v.optional(v.number()),
  scheduledAt: v.optional(v.number()),
};

const draftFields = {
  title: v.string(),
  slug: v.string(),
  excerpt: v.string(),
  content: v.string(),
  focusKeyword: v.optional(v.string()),
  coverImage: v.optional(v.string()),
  category: v.string(),
  tags: v.array(v.string()),
  author: v.string(),
};

type PostInput = {
  title: string;
  slug: string;
  excerpt: string;
  content: string;
  focusKeyword?: string;
  coverImage?: string;
  category: string;
  tags: string[];
  status: "draft" | "published" | "scheduled";
  author: string;
  publishedAt?: number;
  scheduledAt?: number;
};

type DraftInput = {
  title: string;
  slug: string;
  excerpt: string;
  content: string;
  focusKeyword?: string;
  coverImage?: string;
  category: string;
  tags: string[];
  author: string;
};

function normalizeCategory(value: string) {
  return value.trim().replace(/\s+/g, " ");
}

async function canonicalCategory(ctx: MutationCtx, value: string) {
  const name = normalizeCategory(value);
  const category = await ctx.db
    .query("categories")
    .withIndex("by_normalized_name", (q) =>
      q.eq("normalizedName", name.toLowerCase()),
    )
    .first();
  if (!category) {
    throw new Error("Chuyên mục không tồn tại. Hãy chọn hoặc tạo chuyên mục trước.");
  }
  return category.name;
}

function normalizeTiming(post: PostInput): PostInput {
  if (post.status === "published") {
    return {
      ...post,
      publishedAt: post.publishedAt ?? Date.now(),
      scheduledAt: undefined,
    };
  }
  if (post.status === "scheduled") {
    if (!post.scheduledAt || !Number.isFinite(post.scheduledAt)) {
      throw new Error("Scheduled posts require a valid date.");
    }
    return { ...post, publishedAt: undefined };
  }
  return { ...post, publishedAt: undefined, scheduledAt: undefined };
}

function isPublic(post: { status: string; scheduledAt?: number }) {
  return (
    post.status === "published" ||
    (post.status === "scheduled" && (post.scheduledAt ?? Infinity) <= Date.now())
  );
}

function clampLimit(value: number | undefined, fallback = 30) {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.floor(value as number), 1), 100);
}

function readMinutes(content: string) {
  const words = content.trim().split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.ceil(words / 220));
}

function requireAgentToken(token: string) {
  const expected = (
    globalThis as { process?: { env?: Record<string, string | undefined> } }
  ).process?.env?.AGENT_PUBLISHING_TOKEN;
  if (!expected || token !== expected) {
    throw new Error("Unauthorized agent request.");
  }
}

async function upsertDraft(ctx: MutationCtx, rawDraft: DraftInput) {
  const category = await canonicalCategory(ctx, rawDraft.category);
  const existing = await ctx.db
    .query("posts")
    .withIndex("by_slug", (q) => q.eq("slug", rawDraft.slug))
    .unique();
  const now = Date.now();
  const draft = {
    title: rawDraft.title,
    slug: rawDraft.slug,
    excerpt: rawDraft.excerpt,
    content: rawDraft.content,
    category,
    tags: rawDraft.tags,
    author: rawDraft.author,
    status: "draft" as const,
    agentManaged: true,
    updatedAt: now,
    ...(rawDraft.focusKeyword ? { focusKeyword: rawDraft.focusKeyword } : {}),
    ...(rawDraft.coverImage ? { coverImage: rawDraft.coverImage } : {}),
  };

  if (existing) {
    if (existing.status !== "draft") {
      throw new Error(
        "Bài đang published/scheduled. Hãy unpublish về draft trước khi sửa nội dung.",
      );
    }
    await ctx.db.patch(existing._id, {
      ...draft,
      publishedAt: undefined,
      scheduledAt: undefined,
      focusKeyword: rawDraft.focusKeyword || undefined,
      coverImage: rawDraft.coverImage || undefined,
    });
    return {
      id: existing._id,
      action: "updated" as const,
      slug: existing.slug,
      status: "draft" as const,
    };
  }

  const id = await ctx.db.insert("posts", draft);
  return {
    id,
    action: "created" as const,
    slug: rawDraft.slug,
    status: "draft" as const,
  };
}

async function removeDraft(ctx: MutationCtx, slug: string) {
  const post = await ctx.db
    .query("posts")
    .withIndex("by_slug", (q) => q.eq("slug", slug))
    .unique();
  if (!post) return { removed: false as const };
  if (post.status !== "draft") {
    throw new Error("Chỉ xóa được bài draft. Hãy unpublish trước nếu bài đang live.");
  }
  await ctx.db.delete(post._id);
  return { removed: true as const, slug };
}

/** Flip due scheduled posts to published. Used by cron + server tick. */
async function promoteDueScheduledPosts(ctx: MutationCtx) {
  const now = Date.now();
  const scheduled = await ctx.db
    .query("posts")
    .withIndex("by_status", (q) => q.eq("status", "scheduled"))
    .collect();
  const slugs: string[] = [];
  for (const post of scheduled) {
    if ((post.scheduledAt ?? Infinity) > now) continue;
    await ctx.db.patch(post._id, {
      status: "published",
      publishedAt: post.scheduledAt ?? now,
      scheduledAt: undefined,
      updatedAt: now,
    });
    slugs.push(post.slug);
  }
  return { promoted: slugs.length, slugs };
}

export const listPublished = query({
  args: {
    limit: v.optional(v.number()),
    category: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const limit = clampLimit(args.limit);
    const posts = await ctx.db
      .query("posts")
      .withIndex("by_status", (q) => q.eq("status", "published"))
      .order("desc")
      .take(100);
    const scheduled = await ctx.db
      .query("posts")
      .withIndex("by_status", (q) => q.eq("status", "scheduled"))
      .order("desc")
      .take(100);

    return [...posts, ...scheduled]
      .filter(isPublic)
      .filter((post) => (args.category ? post.category === args.category : true))
      .sort(
        (a, b) =>
          (b.publishedAt ?? b.scheduledAt ?? 0) -
          (a.publishedAt ?? a.scheduledAt ?? 0),
      )
      .slice(0, limit)
      .map((post) => ({
        _id: post._id,
        title: post.title,
        slug: post.slug,
        excerpt: post.excerpt,
        coverImage: post.coverImage,
        category: post.category,
        tags: post.tags,
        author: post.author,
        publishedAt: post.publishedAt,
        scheduledAt: post.scheduledAt,
        readMinutes: readMinutes(post.content),
      }));
  },
});

export const getBySlug = query({
  args: { slug: v.string() },
  handler: async (ctx, args) => {
    const post = await ctx.db
      .query("posts")
      .withIndex("by_slug", (q) => q.eq("slug", args.slug))
      .unique();
    if (!post || !isPublic(post)) return null;
    return { ...post, readMinutes: readMinutes(post.content) };
  },
});

export const listAll = query({
  args: { token: v.string() },
  handler: async (ctx, args) => {
    await requireAdminSession(ctx, args.token);
    const posts = await ctx.db.query("posts").collect();
    return posts.sort((a, b) => b.updatedAt - a.updatedAt);
  },
});

export const listAllForAgent = query({
  args: { agentToken: v.string() },
  handler: async (ctx, args) => {
    requireAgentToken(args.agentToken);
    const posts = await ctx.db.query("posts").collect();
    return posts.sort((a, b) => b.updatedAt - a.updatedAt);
  },
});

export const getForAgent = query({
  args: { agentToken: v.string(), slug: v.string() },
  handler: async (ctx, args) => {
    requireAgentToken(args.agentToken);
    const post = await ctx.db
      .query("posts")
      .withIndex("by_slug", (q) => q.eq("slug", args.slug))
      .unique();
    return post ?? null;
  },
});

export const create = mutation({
  args: { token: v.string(), ...postFields },
  handler: async (ctx, args) => {
    const { token, ...rawPost } = args;
    await requireAdminSession(ctx, token);
    const category = await canonicalCategory(ctx, rawPost.category);
    const existing = await ctx.db
      .query("posts")
      .withIndex("by_slug", (q) => q.eq("slug", rawPost.slug))
      .unique();
    if (existing) throw new Error("Slug already exists.");

    const post = normalizeTiming({ ...rawPost, category });
    return await ctx.db.insert("posts", { ...post, updatedAt: Date.now() });
  },
});

export const update = mutation({
  args: { token: v.string(), id: v.id("posts"), ...postFields },
  handler: async (ctx, args) => {
    const { token, id, ...rawPost } = args;
    await requireAdminSession(ctx, token);
    const current = await ctx.db.get(id);
    if (!current) throw new Error("Post not found.");
    const category = await canonicalCategory(ctx, rawPost.category);

    const existingSlug = await ctx.db
      .query("posts")
      .withIndex("by_slug", (q) => q.eq("slug", rawPost.slug))
      .unique();
    if (existingSlug && existingSlug._id !== id) {
      throw new Error("Slug already exists.");
    }

    const post = normalizeTiming({ ...rawPost, category });
    await ctx.db.patch(id, { ...post, updatedAt: Date.now() });
    return true;
  },
});

export const remove = mutation({
  args: { token: v.string(), id: v.id("posts") },
  handler: async (ctx, args) => {
    await requireAdminSession(ctx, args.token);
    const current = await ctx.db.get(args.id);
    if (current) await ctx.db.delete(args.id);
    return true;
  },
});

/** Create or update a draft only. Never publishes. */
export const upsertDraftFromAgent = mutation({
  args: { agentToken: v.string(), ...draftFields },
  handler: async (ctx, args) => {
    const { agentToken, ...rawDraft } = args;
    requireAgentToken(agentToken);
    return await upsertDraft(ctx, rawDraft);
  },
});

/** Delete any draft by slug (editor or agent). */
export const removeDraftFromAgent = mutation({
  args: { agentToken: v.string(), slug: v.string() },
  handler: async (ctx, args) => {
    requireAgentToken(args.agentToken);
    return await removeDraft(ctx, args.slug);
  },
});

/** Publish or schedule a draft. */
export const publishFromAgent = mutation({
  args: {
    agentToken: v.string(),
    slug: v.string(),
    status: v.union(v.literal("published"), v.literal("scheduled")),
    scheduledAt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    requireAgentToken(args.agentToken);
    const post = await ctx.db
      .query("posts")
      .withIndex("by_slug", (q) => q.eq("slug", args.slug))
      .unique();
    if (!post) throw new Error("Không tìm thấy bài viết.");
    if (post.status !== "draft") {
      throw new Error("Chỉ publish/schedule được từ draft. Unpublish trước nếu cần đổi lịch.");
    }

    const next = normalizeTiming({
      title: post.title,
      slug: post.slug,
      excerpt: post.excerpt,
      content: post.content,
      focusKeyword: post.focusKeyword,
      coverImage: post.coverImage,
      category: post.category,
      tags: post.tags,
      author: post.author,
      status: args.status,
      scheduledAt: args.scheduledAt,
    });

    await ctx.db.patch(post._id, {
      status: next.status,
      publishedAt: next.publishedAt,
      scheduledAt: next.scheduledAt,
      updatedAt: Date.now(),
    });

    return {
      id: post._id,
      slug: post.slug,
      status: next.status,
      publishedAt: next.publishedAt,
      scheduledAt: next.scheduledAt,
    };
  },
});

/** Move published/scheduled post back to draft so agent can edit. */
export const unpublishFromAgent = mutation({
  args: { agentToken: v.string(), slug: v.string() },
  handler: async (ctx, args) => {
    requireAgentToken(args.agentToken);
    const post = await ctx.db
      .query("posts")
      .withIndex("by_slug", (q) => q.eq("slug", args.slug))
      .unique();
    if (!post) throw new Error("Không tìm thấy bài viết.");
    if (post.status === "draft") {
      return {
        id: post._id,
        slug: post.slug,
        status: "draft" as const,
        alreadyDraft: true,
      };
    }

    await ctx.db.patch(post._id, {
      status: "draft",
      publishedAt: undefined,
      scheduledAt: undefined,
      updatedAt: Date.now(),
    });

    return {
      id: post._id,
      slug: post.slug,
      status: "draft" as const,
      alreadyDraft: false,
    };
  },
});

/** Legacy alias: rejects non-draft status, upserts draft content. */
export const upsertFromAgent = mutation({
  args: { agentToken: v.string(), ...postFields },
  handler: async (ctx, args) => {
    const { agentToken, status: requestedStatus, publishedAt: _p, scheduledAt: _s, ...rawDraft } =
      args;
    if (requestedStatus && requestedStatus !== "draft") {
      throw new Error(
        "Agent không được tạo/sửa bài ở trạng thái published/scheduled qua endpoint draft. Dùng /publish sau khi chủ nhân duyệt.",
      );
    }
    requireAgentToken(agentToken);
    return await upsertDraft(ctx, rawDraft);
  },
});

/** Legacy alias for removeDraftFromAgent. */
export const removeAgentDraft = mutation({
  args: { agentToken: v.string(), slug: v.string() },
  handler: async (ctx, args) => {
    requireAgentToken(args.agentToken);
    return await removeDraft(ctx, args.slug);
  },
});

/** Convex cron entry: promote scheduled posts that are due. */
export const promoteDueScheduled = internalMutation({
  args: {},
  handler: async (ctx) => await promoteDueScheduledPosts(ctx),
});

/** Server/agent tick entry: same promote, callable with agent token. */
export const promoteDueScheduledForAgent = mutation({
  args: { agentToken: v.string() },
  handler: async (ctx, args) => {
    requireAgentToken(args.agentToken);
    return await promoteDueScheduledPosts(ctx);
  },
});
