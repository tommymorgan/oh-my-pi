/**
 * Keep unmanaged writes and inherited child stdout/stderr off an owned TUI.
 * The renderer uses the saved stdout descriptor; ordinary fd 1/2 writes go
 * to the process log until the terminal is released. Piped output and a
 * separately redirected stderr are left alone.
 */
import { dlopen, FFIType } from "bun:ffi";
import * as fs from "node:fs";
import * as path from "node:path";
import * as tty from "node:tty";
import { getLogPath } from "./dirs";

interface LibcFdOps {
	dup(fd: number): number;
	dup2(oldFd: number, newFd: number): number;
}

let libcFdOpsCache: LibcFdOps | undefined;
let savedStdoutFd: number | null = null;
let savedStderrFd: number | null = null;
let stdoutWriteDescriptor: PropertyDescriptor | undefined;
let stderrWriteDescriptor: PropertyDescriptor | undefined;

function redirectStreamWrites(stream: NodeJS.WriteStream, fd: number): PropertyDescriptor | undefined {
	const descriptor = Object.getOwnPropertyDescriptor(stream, "write");
	stream.write = (
		chunk: string | Uint8Array,
		encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
		callback?: (error?: Error | null) => void,
	): boolean => {
		const done = typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
		const bytes =
			typeof chunk === "string"
				? Buffer.from(chunk, typeof encodingOrCallback === "string" ? encodingOrCallback : "utf8")
				: chunk;
		let offset = 0;
		while (offset < bytes.byteLength) {
			const written = fs.writeSync(fd, bytes, offset, bytes.byteLength - offset);
			if (written === 0) throw new Error("Cannot write isolated terminal output");
			offset += written;
		}
		if (done) queueMicrotask(() => done(null));
		return true;
	};
	return descriptor;
}

function restoreStreamWrite(stream: NodeJS.WriteStream, descriptor: PropertyDescriptor | undefined): void {
	if (descriptor) Object.defineProperty(stream, "write", descriptor);
	else Reflect.deleteProperty(stream, "write");
}

function libcFdOps(): LibcFdOps {
	if (libcFdOpsCache) return libcFdOpsCache;
	const candidates =
		process.platform === "darwin" ? ["libSystem.B.dylib", "/usr/lib/libSystem.B.dylib"] : ["libc.so.6", "libc.so"];
	for (const candidate of candidates) {
		try {
			const libc = dlopen(candidate, {
				dup: { args: [FFIType.i32], returns: FFIType.i32 },
				dup2: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
			});
			libcFdOpsCache = libc.symbols;
			return libcFdOpsCache;
		} catch {
			// Try the next libc soname; never start an unprotected Unix TUI.
		}
	}
	throw new Error("Cannot isolate terminal output: libc descriptor operations are unavailable");
}

function stderrSharesStdoutTerminal(): boolean {
	if (!tty.isatty(2)) return false;
	const stdoutStat = fs.fstatSync(1);
	const stderrStat = fs.fstatSync(2);
	return stdoutStat.dev === stderrStat.dev && stdoutStat.ino === stderrStat.ino;
}

/** Return the renderer's private stdout fd, or null for non-Unix/non-TTY output. */
export function suppressTerminalOutput(): number | null {
	if (savedStdoutFd !== null) return savedStdoutFd;
	if (process.platform === "win32" || !tty.isatty(1)) return null;
	// Initialize Bun's cached streams before replacing the descriptors. Other
	// TUI code must continue to see a terminal, not lazily construct file streams.
	void process.stdout;
	void process.stderr;
	const redirectStderr = stderrSharesStdoutTerminal();
	const libc = libcFdOps();
	const redirectPath = getLogPath();
	fs.mkdirSync(path.dirname(redirectPath), { recursive: true });
	const redirectFd = fs.openSync(redirectPath, "a", 0o600);
	let stdoutFd = -1;
	let stderrFd = -1;
	let stdoutWritesRedirected = false;
	try {
		stdoutFd = libc.dup(1);
		if (stdoutFd === -1) throw new Error("Cannot save terminal stdout");
		if (redirectStderr) {
			stderrFd = libc.dup(2);
			if (stderrFd === -1) throw new Error("Cannot save terminal stderr");
			if (libc.dup2(redirectFd, 2) === -1) throw new Error("Cannot redirect terminal stderr");
		}
		if (libc.dup2(redirectFd, 1) === -1) throw new Error("Cannot redirect terminal stdout");
		// Bun caches private TTY descriptors inside these streams; dup2 alone
		// does not intercept extension writes through their cached write methods.
		stdoutWriteDescriptor = redirectStreamWrites(process.stdout, 1);
		stdoutWritesRedirected = true;
		if (redirectStderr) stderrWriteDescriptor = redirectStreamWrites(process.stderr, 2);
		savedStdoutFd = stdoutFd;
		savedStderrFd = stderrFd === -1 ? null : stderrFd;
		return stdoutFd;
	} catch (err) {
		if (stdoutWritesRedirected) restoreStreamWrite(process.stdout, stdoutWriteDescriptor);
		if (stdoutFd !== -1) {
			libc.dup2(stdoutFd, 1);
			fs.closeSync(stdoutFd);
		}
		if (stderrFd !== -1) {
			libc.dup2(stderrFd, 2);
			fs.closeSync(stderrFd);
		}
		throw err;
	} finally {
		fs.closeSync(redirectFd);
	}
}

/** Restore both descriptors before external programs, suspend, or fatal reports. */
export function restoreTerminalOutput(): void {
	if (savedStdoutFd === null && savedStderrFd === null) return;
	const libc = libcFdOps();
	// Keep a failed restoration retryable. Restore stderr even if stdout fails.
	const stdoutRestored = savedStdoutFd === null || libc.dup2(savedStdoutFd, 1) !== -1;
	const stderrRestored = savedStderrFd === null || libc.dup2(savedStderrFd, 2) !== -1;
	if (stdoutRestored && savedStdoutFd !== null) {
		restoreStreamWrite(process.stdout, stdoutWriteDescriptor);
		stdoutWriteDescriptor = undefined;
		fs.closeSync(savedStdoutFd);
		savedStdoutFd = null;
	}
	if (stderrRestored && savedStderrFd !== null) {
		restoreStreamWrite(process.stderr, stderrWriteDescriptor);
		stderrWriteDescriptor = undefined;
		fs.closeSync(savedStderrFd);
		savedStderrFd = null;
	}
	if (!stdoutRestored || !stderrRestored) throw new Error("Cannot restore terminal output descriptors");
}
