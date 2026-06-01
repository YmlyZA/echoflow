export type BackendConfig = {
  apiKey: string;
  port: number;
};

export type BackendConfigInput = Partial<BackendConfig>;

const DEFAULT_API_KEY = "dev-key";
const DEFAULT_PORT = 8787;

export function createConfig(input: BackendConfigInput = {}): BackendConfig {
  return {
    apiKey: input.apiKey ?? process.env.ECHOFLOW_API_KEY ?? DEFAULT_API_KEY,
    port:
      input.port ??
      readPort(process.env.ECHOFLOW_PORT, "ECHOFLOW_PORT") ??
      readPort(process.env.PORT, "PORT") ??
      DEFAULT_PORT,
  };
}

function readPort(value: string | undefined, name: string): number | undefined {
  if (value === undefined || value.trim() === "") {
    return undefined;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65_535) {
    throw new Error(`Invalid ${name} value: ${value}`);
  }

  return parsed;
}
