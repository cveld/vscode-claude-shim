import { getPinnedTarget } from "@/simulator-lib/simulatorTarget";

export type WorkspaceFolderInfo = {
  index: number;
  name: string;
  uri: {
    scheme: "file";
    fsPath: string;
    path: string;
    toString(): string;
  };
};

export type SimulatorConfigurationSnapshot = Record<string, unknown>;

const DEFAULT_CONFIGURATION: SimulatorConfigurationSnapshot = {
  "claudeCode.useTerminal": false,
  "claudeCode.disableLoginPrompt": false,
  "claudeCode.claudeProcessWrapper": "",
  "claudeCode.environmentVariables": [],
  "claudeCode.preferredLocation": "panel",
  "claudeCode.initialPermissionMode": "default",
};

export function getWorkspaceFolders(): WorkspaceFolderInfo[] {
  const target = getPinnedTarget();
  return target.workspaceFolders.map((folder, index) => ({
    index,
    name: folder.split(/[/\\]/).filter(Boolean).at(-1) ?? folder,
    uri: createFileUri(folder),
  }));
}

export function getConfigurationSnapshot(): SimulatorConfigurationSnapshot {
  return { ...DEFAULT_CONFIGURATION };
}

export function getConfigurationValue(section?: string): unknown {
  if (!section) return getConfigurationSnapshot();
  return DEFAULT_CONFIGURATION[section];
}

function createFileUri(fsPath: string) {
  const normalized = fsPath.replace(/\\/g, "/");
  const path = normalized.startsWith("/") ? normalized : `/${normalized}`;
  return {
    scheme: "file" as const,
    fsPath,
    path,
    toString() {
      return `file://${path}`;
    },
  };
}
