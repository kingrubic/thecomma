import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// Promote scheduled posts whose scheduledAt has passed.
// The Comma Node server also ticks this and regenerates /stories/ when needed.
crons.interval(
  "promote due scheduled posts",
  { minutes: 1 },
  internal.posts.promoteDueScheduled,
);

export default crons;
