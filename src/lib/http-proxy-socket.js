import { Mutex } from "async-mutex";
import * as net from "node:net";
import * as tls from "node:tls";

const mutex = new Mutex();
const closeError = new Error("NetSocket was closed");

function buildProxyAuthorizationHeader(username, password) {
  if (!username) {
    return null;
  }

  const token = Buffer.from(`${username}:${password || ""}`, "utf8").toString("base64");
  return `Proxy-Authorization: Basic ${token}`;
}

function createProxySocket(proxy) {
  const options = {
    host: proxy.ip,
    port: proxy.port,
  };

  return proxy.protocol === "https" ? tls.connect(options) : net.connect(options);
}

function waitForSocketConnect(socket, protocol, timeoutMs) {
  return new Promise((resolve, reject) => {
    const connectEvent = protocol === "https" ? "secureConnect" : "connect";

    const cleanup = () => {
      socket.setTimeout(0);
      socket.off(connectEvent, onConnect);
      socket.off("error", onError);
      socket.off("timeout", onTimeout);
    };

    const onConnect = () => {
      cleanup();
      resolve();
    };

    const onError = (error) => {
      cleanup();
      reject(error);
    };

    const onTimeout = () => {
      cleanup();
      reject(new Error("Timed out while connecting to the HTTP proxy."));
    };

    socket.setTimeout(timeoutMs);
    socket.once(connectEvent, onConnect);
    socket.once("error", onError);
    socket.once("timeout", onTimeout);
  });
}

function establishHttpTunnel(socket, destination, proxy, timeoutMs) {
  return new Promise((resolve, reject) => {
    const headers = [
      `CONNECT ${destination.host}:${destination.port} HTTP/1.1`,
      `Host: ${destination.host}:${destination.port}`,
      "Connection: Keep-Alive",
      "Proxy-Connection: Keep-Alive",
    ];
    const authHeader = buildProxyAuthorizationHeader(proxy.username, proxy.password);

    if (authHeader) {
      headers.push(authHeader);
    }

    const cleanup = () => {
      socket.setTimeout(0);
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("timeout", onTimeout);
      socket.off("close", onClose);
    };

    const onError = (error) => {
      cleanup();
      reject(error);
    };

    const onTimeout = () => {
      cleanup();
      reject(new Error("Timed out while establishing the HTTP proxy tunnel."));
    };

    const onClose = () => {
      cleanup();
      reject(new Error("HTTP proxy closed the connection before the CONNECT tunnel was established."));
    };

    let response = Buffer.alloc(0);

    const onData = (chunk) => {
      response = Buffer.concat([response, chunk]);
      const headerEnd = response.indexOf("\r\n\r\n");

      if (headerEnd === -1) {
        return;
      }

      cleanup();
      const headerText = response.subarray(0, headerEnd).toString("utf8");
      const statusLine = headerText.split("\r\n", 1)[0] || "";

      if (!/^HTTP\/1\.[01] 200\b/i.test(statusLine)) {
        reject(new Error(`HTTP proxy CONNECT failed: ${statusLine || "unknown response"}`));
        return;
      }

      resolve(response.subarray(headerEnd + 4));
    };

    socket.setTimeout(timeoutMs);
    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("timeout", onTimeout);
    socket.once("close", onClose);
    socket.write(`${headers.join("\r\n")}\r\n\r\n`);
  });
}

export class HttpProxyPromisedNetSockets {
  constructor(proxy) {
    this.client = undefined;
    this.closed = true;
    this.stream = Buffer.alloc(0);

    if (!proxy?.ip || !proxy?.port || !proxy?.protocol) {
      throw new Error("Invalid HTTP proxy settings for Telegram.");
    }

    if (!["http", "https"].includes(proxy.protocol)) {
      throw new Error(`Unsupported Telegram HTTP proxy protocol: ${proxy.protocol}`);
    }

    this.proxy = proxy;
    this.timeoutMs = (Number(proxy.timeout) || 10) * 1000;
  }

  async readExactly(number) {
    let readData = Buffer.alloc(0);

    while (true) {
      const thisTime = await this.read(number);
      readData = Buffer.concat([readData, thisTime]);
      number -= thisTime.length;

      if (!number || number === -437) {
        return readData;
      }
    }
  }

  async read(number) {
    if (this.closed) {
      throw closeError;
    }

    await this.canRead;

    if (this.closed) {
      throw closeError;
    }

    const toReturn = this.stream.slice(0, number);
    this.stream = this.stream.slice(number);

    if (this.stream.length === 0) {
      this.canRead = new Promise((resolve) => {
        this.resolveRead = resolve;
      });
    }

    return toReturn;
  }

  async readAll() {
    if (this.closed || !(await this.canRead)) {
      throw closeError;
    }

    const toReturn = this.stream;
    this.stream = Buffer.alloc(0);
    this.canRead = new Promise((resolve) => {
      this.resolveRead = resolve;
    });

    return toReturn;
  }

  async connect(port, ip) {
    this.stream = Buffer.alloc(0);
    this.canRead = new Promise((resolve) => {
      this.resolveRead = resolve;
    });
    this.closed = false;

    const socket = createProxySocket(this.proxy);
    this.client = socket;

    socket.on("close", () => {
      if (this.client?.destroyed) {
        if (this.resolveRead) {
          this.resolveRead(false);
        }

        this.closed = true;
      }
    });

    await waitForSocketConnect(socket, this.proxy.protocol, this.timeoutMs);
    const remainder = await establishHttpTunnel(
      socket,
      { host: ip, port },
      this.proxy,
      this.timeoutMs,
    );

    if (remainder.length > 0) {
      this.stream = Buffer.concat([this.stream, remainder]);
      if (this.resolveRead) {
        this.resolveRead(true);
      }
    }

    this.receive();
    return this;
  }

  write(data) {
    if (this.closed) {
      throw closeError;
    }

    if (this.client) {
      this.client.write(data);
    }
  }

  async close() {
    if (this.client) {
      this.client.destroy();
      this.client.unref?.();
    }

    this.closed = true;
  }

  async receive() {
    if (this.client) {
      this.client.on("data", async (message) => {
        const release = await mutex.acquire();

        try {
          this.stream = Buffer.concat([this.stream, message]);
          if (this.resolveRead) {
            this.resolveRead(true);
          }
        } finally {
          release();
        }
      });
    }
  }

  toString() {
    return "HttpProxyPromisedNetSocket";
  }
}
