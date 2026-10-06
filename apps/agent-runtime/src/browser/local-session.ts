import type { ServicesSnapshot } from "@swarm/contracts";
import { hostOf, matchRecipe, rootDomain } from "../onboarding/domains";

/**
 * Сервис, в который Skyvern уже вошёл и cookies лежат в профиле своего Chromium.
 * Задачу в нём снова через Skyvern не начинают: страница открывается этим профилем.
 */
export function savedBrowserSlug(services: ServicesSnapshot | null, url: string): string | null {
  if (!services) return null;
  const host = hostOf(url);
  if (!host) return null;
  const recipe = matchRecipe(services.recipes, [host, rootDomain(host)]);
  if (!recipe) return null;
  const cred = services.credentials.find((c) => c.slug === recipe.slug);
  const state = cred?.storageState;
  if (!state || typeof state !== "object") return null;
  const provider = (state as { provider?: unknown }).provider;
  return provider === "local" ? recipe.slug : null;
}
