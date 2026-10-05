function opt(name: string): string | undefined {
  const v = process.env[name];
  return v && v.length > 0 ? v : undefined;
}

function need(name: string): string {
  const v = opt(name);
  if (!v) throw new Error(`${name} не задан`);
  return v;
}

/** Ленивое чтение: UI и реестр работают без секретов провайдеров. */
export const env = {
  get databaseUrl() {
    return need("DATABASE_URL");
  },
  get authSecret() {
    return need("AUTH_SECRET");
  },
  get appUrl() {
    return opt("APP_URL") ?? "http://localhost:3000";
  },
  get agentsDomain() {
    return need("AGENTS_DOMAIN");
  },
  get webhookUrl() {
    return opt("WEBHOOK_URL") ?? `${this.appUrl}/webhooks/email`;
  },
  get openRouterApiKey() {
    return opt("OPENROUTER_API_KEY") ?? opt("OPEN_ROUTER_API_KEY");
  },
  /** SHA коммита, из которого собран этот control plane. Пусто — ручная выкладка. */
  get release() {
    return opt("RELEASE");
  },
  mailgun: {
    get apiKey() {
      return opt("MAILGUN_API_KEY");
    },
    get signingKey() {
      return opt("MAILGUN_SIGNING_KEY");
    },
    get region(): "us" | "eu" {
      return (opt("MAILGUN_REGION") ?? "eu").toLowerCase() === "us" ? "us" : "eu";
    },
  },
  get inboundWebhookToken() {
    return opt("INBOUND_WEBHOOK_TOKEN");
  },
  fly: {
    get apiToken() {
      return opt("FLY_API_TOKEN");
    },
    get org() {
      return opt("FLY_ORG") ?? "personal";
    },
    get region() {
      return opt("FLY_REGION") ?? "ams";
    },
    /** Образ runtime того же коммита, что и control plane. Без RELEASE — `latest`. */
    get runtimeImage() {
      const explicit = opt("AGENT_RUNTIME_IMAGE");
      if (explicit) return explicit;
      const release = opt("RELEASE");
      return release ? `registry.fly.io/swarm-agent-runtime:${release}` : "registry.fly.io/swarm-agent-runtime:latest";
    },
    get hermesImage() {
      return opt("HERMES_IMAGE") ?? "nousresearch/hermes-agent:latest";
    },
  },
  get skyvernApiKey() {
    return opt("SKYVERN_API_KEY");
  },
  google: {
    get clientId() {
      return opt("GOOGLE_CLIENT_ID");
    },
    get clientSecret() {
      return opt("GOOGLE_CLIENT_SECRET");
    },
  },
  /** В разработке можно указать адрес локального runtime вместо Fly. */
  get devRuntimeUrl() {
    return opt("DEV_RUNTIME_URL");
  },
};
