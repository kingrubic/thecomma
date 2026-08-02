import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireAdminSession } from "./adminAuth";

const categoryName = v.string();

function normalizeName(value: string) {
  return value.trim().replace(/\s+/g, " ");
}

function normalizedName(value: string) {
  return normalizeName(value).toLowerCase();
}

function validateName(value: string) {
  const name = normalizeName(value);
  if (name.length < 2 || name.length > 60) {
    throw new Error("Tên chuyên mục cần từ 2 đến 60 ký tự.");
  }
  if (/[\u0000-\u001f\u007f]/.test(name)) {
    throw new Error("Tên chuyên mục chứa ký tự không hợp lệ.");
  }
  return name;
}

export const list = query({
  args: { token: v.string() },
  handler: async (ctx, args) => {
    await requireAdminSession(ctx, args.token);
    const [categories, posts] = await Promise.all([
      ctx.db.query("categories").collect(),
      ctx.db.query("posts").collect(),
    ]);
    const postCounts = new Map<string, number>();
    for (const post of posts) {
      postCounts.set(post.category, (postCounts.get(post.category) ?? 0) + 1);
    }
    return categories
      .sort((a, b) => a.name.localeCompare(b.name, "vi"))
      .map((category) => ({
        _id: category._id,
        name: category.name,
        postCount: postCounts.get(category.name) ?? 0,
        createdAt: category.createdAt,
        updatedAt: category.updatedAt,
      }));
  },
});

export const listForAgent = query({
  args: {},
  handler: async (ctx) => {
    const categories = await ctx.db.query("categories").collect();
    return categories
      .sort((a, b) => a.name.localeCompare(b.name, "vi"))
      .map((category) => category.name);
  },
});

export const create = mutation({
  args: { token: v.string(), name: categoryName },
  handler: async (ctx, args) => {
    await requireAdminSession(ctx, args.token);
    const name = validateName(args.name);
    const key = normalizedName(name);
    const existing = await ctx.db
      .query("categories")
      .withIndex("by_normalized_name", (q) => q.eq("normalizedName", key))
      .first();
    if (existing) throw new Error("Chuyên mục này đã tồn tại.");

    const now = Date.now();
    const id = await ctx.db.insert("categories", {
      name,
      normalizedName: key,
      createdAt: now,
      updatedAt: now,
    });
    return { id, name };
  },
});

export const update = mutation({
  args: { token: v.string(), id: v.id("categories"), name: categoryName },
  handler: async (ctx, args) => {
    await requireAdminSession(ctx, args.token);
    const current = await ctx.db.get(args.id);
    if (!current) throw new Error("Không tìm thấy chuyên mục.");

    const name = validateName(args.name);
    const key = normalizedName(name);
    const existing = await ctx.db
      .query("categories")
      .withIndex("by_normalized_name", (q) => q.eq("normalizedName", key))
      .first();
    if (existing && existing._id !== current._id) {
      throw new Error("Chuyên mục này đã tồn tại.");
    }

    const now = Date.now();
    const relatedPosts = await ctx.db
      .query("posts")
      .withIndex("by_category", (q) => q.eq("category", current.name))
      .collect();
    await ctx.db.patch(current._id, {
      name,
      normalizedName: key,
      updatedAt: now,
    });
    for (const post of relatedPosts) {
      await ctx.db.patch(post._id, { category: name, updatedAt: now });
    }
    return { ok: true, updatedPosts: relatedPosts.length, name };
  },
});

export const remove = mutation({
  args: { token: v.string(), id: v.id("categories") },
  handler: async (ctx, args) => {
    await requireAdminSession(ctx, args.token);
    const current = await ctx.db.get(args.id);
    if (!current) throw new Error("Không tìm thấy chuyên mục.");

    const relatedPosts = await ctx.db
      .query("posts")
      .withIndex("by_category", (q) => q.eq("category", current.name))
      .take(1);
    if (relatedPosts.length) {
      throw new Error("Không thể xóa chuyên mục đang được dùng bởi bài viết. Hãy đổi chuyên mục cho các bài trước.");
    }
    await ctx.db.delete(current._id);
    return { ok: true };
  },
});
