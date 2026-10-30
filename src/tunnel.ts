// From onlycats-poster, plus keepalives and an exit callback: this process runs for days, not one post
import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import { setTimeout as sleep } from "node:timers/promises";

const freePort = () =>
    new Promise<number>((resolve, reject) => {
        const server = net.createServer();
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
            const { port } = server.address() as net.AddressInfo;
            server.close(() => resolve(port));
        });
    });

const canConnect = (port: number) =>
    new Promise<boolean>((resolve) => {
        const socket = net.connect(port, "127.0.0.1");
        socket.once("connect", () => {
            socket.destroy();
            resolve(true);
        });
        socket.once("error", () => resolve(false));
    });

/**
 * Forwards a local port to the daemon's RPC port on sshHost, so the daemon sees a localhost connection and needs
 * no RPC auth key. Returns the local RPC URL and a function that closes the tunnel. onExit is called if the tunnel
 * dies later, after it opened.
 */
export async function openRpcTunnel(
    sshHost: string,
    remotePort = 9138,
    onExit: (reason: string) => void = () => {}
): Promise<{ rpcUrl: string; close: () => void }> {
    const port = await freePort();
    const ssh: ChildProcess = spawn(
        "ssh",
        [
            "-N",
            "-o",
            "BatchMode=yes",
            "-o",
            "ExitOnForwardFailure=yes",
            "-o",
            "ConnectTimeout=15",
            "-o",
            "ServerAliveInterval=30",
            "-o",
            "ServerAliveCountMax=3",
            "-L",
            `127.0.0.1:${port}:127.0.0.1:${remotePort}`,
            sshHost
        ],
        { stdio: ["ignore", "ignore", "pipe"] }
    );
    let stderr = "";
    let closing = false;
    ssh.stderr?.on("data", (chunk) => (stderr += chunk));
    const close = () => {
        closing = true;
        if (ssh.exitCode === null) ssh.kill();
    };

    for (let waited = 0; waited < 30_000; waited += 250) {
        if (ssh.exitCode !== null) throw new Error(`ssh tunnel to ${sshHost} exited: ${stderr.trim()}`);
        if (await canConnect(port)) {
            ssh.once("exit", (code) => {
                if (!closing) onExit(`ssh tunnel to ${sshHost} exited with ${code}: ${stderr.trim().split("\n").at(-1) ?? ""}`);
            });
            return { rpcUrl: `ws://127.0.0.1:${port}`, close };
        }
        await sleep(250);
    }
    close();
    throw new Error(`ssh tunnel to ${sshHost} did not open within 30 s: ${stderr.trim()}`);
}
