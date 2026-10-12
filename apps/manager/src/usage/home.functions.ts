import { env } from "cloudflare:workers";
import { createServerFn } from "@tanstack/react-start";
import { requireSession } from "../server/auth.server";
import type { HomeUsageData } from "./home";
import { readHomeUsage } from "./home.server";

/** Any signed-in user: Home's usage section and the charts on its app cards (members read it too). */
export const getHomeUsage = createServerFn({ method: "GET" }).handler(
  async (): Promise<HomeUsageData> => {
    await requireSession();
    return readHomeUsage(env.DB, env.KV);
  },
);
