import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type {
  ChatSnapshot,
  ClientCommand,
  ClientEnvelope,
  LocalProjectsSnapshot,
  ServerEnvelope,
  SidebarData,
  SocketStatus,
} from "@/lib/phoenix-types";

const SIDEBAR_SUBSCRIPTION_ID = "sidebar";
const LOCAL_PROJECTS_SUBSCRIPTION_ID = "local-projects";
const CHAT_SUBSCRIPTION_ID = "chat";

function createId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function toWebSocketUrl(baseUrl: string) {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  if (!trimmed) {
    return null;
  }
  if (trimmed.startsWith("https://")) {
    return `wss://${trimmed.slice("https://".length)}/ws`;
  }
  if (trimmed.startsWith("http://")) {
    return `ws://${trimmed.slice("http://".length)}/ws`;
  }
  return `ws://${trimmed}/ws`;
}

export function usePhoenixClient(baseUrl: string, activeChatId: string | null) {
  const wsUrl = useMemo(() => toWebSocketUrl(baseUrl), [baseUrl]);
  const socketRef = useRef<WebSocket | null>(null);
  const activeChatIdRef = useRef<string | null>(activeChatId);
  const pendingRef = useRef(
    new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
  );

  const [status, setStatus] = useState<SocketStatus>("connecting");
  const [sidebar, setSidebar] = useState<SidebarData>({ projectGroups: [] });
  const [localProjects, setLocalProjects] = useState<LocalProjectsSnapshot | null>(null);
  const [chat, setChat] = useState<ChatSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);

  const sendEnvelope = useCallback((envelope: ClientEnvelope) => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error("Phoenix server is not connected");
    }
    socket.send(JSON.stringify(envelope));
  }, []);

  const sendCommand = useCallback((command: ClientCommand) => {
    return new Promise<unknown>((resolve, reject) => {
      const id = createId();
      pendingRef.current.set(id, { resolve, reject });
      try {
        sendEnvelope({ v: 1, type: "command", id, command });
      } catch (commandError) {
        pendingRef.current.delete(id);
        reject(commandError instanceof Error ? commandError : new Error(String(commandError)));
      }
    });
  }, [sendEnvelope]);

  const subscribeCore = useCallback(() => {
    sendEnvelope({ v: 1, type: "subscribe", id: SIDEBAR_SUBSCRIPTION_ID, topic: { type: "sidebar" } });
    sendEnvelope({
      v: 1,
      type: "subscribe",
      id: LOCAL_PROJECTS_SUBSCRIPTION_ID,
      topic: { type: "local-projects" },
    });
    if (activeChatIdRef.current) {
      sendEnvelope({
        v: 1,
        type: "subscribe",
        id: CHAT_SUBSCRIPTION_ID,
        topic: { type: "chat", chatId: activeChatIdRef.current },
      });
    }
  }, [sendEnvelope]);

  useEffect(() => {
    let cancelled = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let lastHealthOk = false;

    function rejectPending(message: string) {
      for (const pending of pendingRef.current.values()) {
        pending.reject(new Error(message));
      }
      pendingRef.current.clear();
    }

    async function probeHealth() {
      const trimmed = baseUrl.trim().replace(/\/+$/, "");
      if (!trimmed) {
        lastHealthOk = false;
        return;
      }
      try {
        const response = await fetch(`${trimmed}/health`);
        lastHealthOk = response.ok;
      } catch {
        lastHealthOk = false;
      }
    }

    if (!wsUrl) {
      setStatus("disconnected");
      setError("Enter your Phoenix server URL to connect.");
      setChat(null);
      return () => {
        rejectPending("Socket disposed");
      };
    }

    function connect() {
      if (!wsUrl) {
        return;
      }
      setStatus("connecting");
      void probeHealth();
      const socket = new WebSocket(wsUrl);
      socketRef.current = socket;

      socket.onopen = () => {
        if (cancelled) {
          socket.close();
          return;
        }
        console.log("[phoenix-mobile] ws open", wsUrl);
        setStatus("connected");
        setError(null);
        subscribeCore();
      };

      socket.onmessage = (event) => {
        console.log("[phoenix-mobile] ws message", typeof event.data === "string" ? event.data.slice(0, 120) : "binary");
        const payload = JSON.parse(String(event.data)) as ServerEnvelope;

        if (payload.type === "snapshot") {
          if (payload.snapshot.type === "sidebar") {
            setSidebar(payload.snapshot.data);
            return;
          }
          if (payload.snapshot.type === "local-projects") {
            setLocalProjects(payload.snapshot.data);
            return;
          }
          if (payload.snapshot.type === "chat") {
            setChat(payload.snapshot.data);
          }
          return;
        }

        if (payload.type === "ack") {
          const pending = pendingRef.current.get(payload.id);
          if (!pending) return;
          pendingRef.current.delete(payload.id);
          pending.resolve(payload.result);
          return;
        }

        if (payload.type === "error") {
          if (!payload.id) {
            setError(payload.message);
            return;
          }
          const pending = pendingRef.current.get(payload.id);
          if (!pending) return;
          pendingRef.current.delete(payload.id);
          pending.reject(new Error(payload.message));
        }
      };

      socket.onerror = (event) => {
        console.log("[phoenix-mobile] ws error", wsUrl, JSON.stringify(event));
        setError(lastHealthOk ? "Phoenix server is reachable, but the live socket failed." : "Failed to reach the Phoenix server");
      };

      socket.onclose = (event) => {
        console.log("[phoenix-mobile] ws close", wsUrl, event.code, event.reason);
        if (cancelled) return;
        setStatus("disconnected");
        if (lastHealthOk) {
          setError(`Live socket closed (${event.code || "unknown"}).`);
        }
        rejectPending("Disconnected from Phoenix");
        reconnectTimer = setTimeout(connect, 1200);
      };
    }

    connect();

    return () => {
      cancelled = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
      }
      socketRef.current?.close();
      socketRef.current = null;
      rejectPending("Socket disposed");
    };
  }, [subscribeCore, wsUrl]);

  useEffect(() => {
    activeChatIdRef.current = activeChatId;
    if (status !== "connected") {
      return;
    }

    try {
      sendEnvelope({ v: 1, type: "unsubscribe", id: CHAT_SUBSCRIPTION_ID });
      if (!activeChatId) {
        setChat(null);
        return;
      }
      sendEnvelope({
        v: 1,
        type: "subscribe",
        id: CHAT_SUBSCRIPTION_ID,
        topic: { type: "chat", chatId: activeChatId },
      });
    } catch (subscriptionError) {
      setError(subscriptionError instanceof Error ? subscriptionError.message : String(subscriptionError));
    }
  }, [activeChatId, sendEnvelope, status]);

  return {
    status,
    sidebar,
    localProjects,
    chat,
    error,
    setError,
    sendCommand,
  };
}
