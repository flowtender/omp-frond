// lib/open-in-file-manager with the launch recorded on
// `globalThis.__ompWebFileManagerLaunches` instead of raising a file-manager
// window on the machine that runs the tests.
export { fileManagerCommand, isFileManagerSupported, isLoopbackHost } from "@/lib/open-in-file-manager";

export async function launchFileManager(target) {
  (globalThis.__ompWebFileManagerLaunches ??= []).push(target);
}
