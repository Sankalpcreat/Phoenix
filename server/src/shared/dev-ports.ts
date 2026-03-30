export const DEFAULT_DEV_CLIENT_PORT = 5174

export function getDefaultDevServerPort(clientPort = DEFAULT_DEV_CLIENT_PORT) {
  return clientPort + 1
}

export interface DevArgResolution {
  clientPort: number
  serverPort: number
  share: boolean
  backendTargetHost: string
  allowedHosts: true | string[]
  serverArgs: string[]
}

export function resolveDevPorts(args: string[]) {
  let clientPort = DEFAULT_DEV_CLIENT_PORT

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg !== "--port") continue

    const next = args[index + 1]
    if (!next || next.startsWith("-")) {
      throw new Error("Missing value for --port")
    }

    clientPort = Number(next)
    index += 1
  }

  return {
    clientPort,
    serverPort: getDefaultDevServerPort(clientPort),
  }
}

export function stripPortArg(args: string[]) {
  const stripped: string[] = []

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === "--port") {
      index += 1
      continue
    }

    stripped.push(arg)
  }

  return stripped
}

export function parseDevArgs(args: string[], localHostname: string): DevArgResolution {
  const { clientPort, serverPort } = resolveDevPorts(args)
  const serverArgs = stripPortArg(args).filter((arg) => arg !== "--share")
  let share = false
  let sawHost = false
  let sawRemote = false
  let backendTargetHost = "127.0.0.1"
  let allowAllHosts = false
  const hosts = new Set<string>(["localhost", "127.0.0.1", "0.0.0.0", localHostname])

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === "--share") {
      if (sawHost) throw new Error("--share cannot be used with --host")
      if (sawRemote) throw new Error("--share cannot be used with --remote")
      share = true
      continue
    }
    if (arg === "--remote") {
      if (share) throw new Error("--share cannot be used with --remote")
      sawRemote = true
      backendTargetHost = "127.0.0.1"
      allowAllHosts = true
      continue
    }
    if (arg !== "--host") continue

    const next = args[index + 1]
    if (!next || next.startsWith("-")) continue
    if (share) throw new Error("--share cannot be used with --host")
    sawHost = true
    hosts.add(next)
    backendTargetHost = next === "0.0.0.0" ? "127.0.0.1" : next
    index += 1
  }

  return {
    clientPort,
    serverPort,
    share,
    backendTargetHost,
    allowedHosts: share || allowAllHosts ? true : [...hosts],
    serverArgs,
  }
}
