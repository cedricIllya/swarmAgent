import { toNextJsHandler } from "better-auth/next-js";
import { auth } from "@/lib/auth";

// Ленивая инициализация: auth() читает DATABASE_URL только на первом запросе.
const handler = toNextJsHandler((request: Request) => auth().handler(request));

export const { GET, POST } = handler;
