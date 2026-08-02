import { v } from "convex/values";
import { internalMutation } from "./_generated/server";

const importedPost = v.object({
  title: v.string(),
  slug: v.string(),
  excerpt: v.string(),
  content: v.string(),
  coverImage: v.optional(v.string()),
  category: v.string(),
  tags: v.array(v.string()),
  author: v.string(),
  publishedAt: v.number(),
});

function normalizeCategory(value: string) {
  return value.trim().replace(/\s+/g, " ");
}

export const importStaticPosts = internalMutation({
  args: { posts: v.array(importedPost) },
  handler: async (ctx, args) => {
    const existingPosts = await ctx.db.query("posts").collect();
    const existingCategories = await ctx.db.query("categories").collect();
    const existingBySlug = new Set(existingPosts.map((post) => post.slug));
    const categoryKeys = new Set(existingCategories.map((category) => category.normalizedName));
    const inputSlugs = new Set<string>();
    const now = Date.now();
    let created = 0;
    let skipped = 0;
    let categoriesCreated = 0;

    for (const post of args.posts) {
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(post.slug)) {
        throw new Error(`Invalid slug: ${post.slug}`);
      }
      if (inputSlugs.has(post.slug)) throw new Error(`Duplicate import slug: ${post.slug}`);
      inputSlugs.add(post.slug);

      const category = normalizeCategory(post.category);
      const normalizedName = category.toLowerCase();
      if (!categoryKeys.has(normalizedName)) {
        await ctx.db.insert("categories", {
          name: category,
          normalizedName,
          createdAt: now,
          updatedAt: now,
        });
        categoryKeys.add(normalizedName);
        categoriesCreated += 1;
      }

      if (existingBySlug.has(post.slug)) {
        skipped += 1;
        continue;
      }
      await ctx.db.insert("posts", {
        ...post,
        category,
        status: "published",
        updatedAt: post.publishedAt,
      });
      existingBySlug.add(post.slug);
      created += 1;
    }

    return { created, skipped, categoriesCreated, total: args.posts.length };
  },
});
