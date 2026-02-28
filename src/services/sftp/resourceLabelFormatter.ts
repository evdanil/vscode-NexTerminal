type LabelFormatter = {
  scheme: string;
  formatting: {
    label: string;
    separator: string;
    tildify: boolean;
    workspaceSuffix: string;
  };
};

type WorkspaceWithOptionalFormatter = {
  registerResourceLabelFormatter?: (formatter: LabelFormatter) => unknown;
};

export function tryRegisterResourceLabelFormatter(workspace: unknown, scheme: string): void {
  if (!workspace || typeof workspace !== "object") {
    return;
  }

  try {
    const registerFormatter = (workspace as WorkspaceWithOptionalFormatter).registerResourceLabelFormatter;
    if (typeof registerFormatter !== "function") {
      return;
    }

    registerFormatter.call(workspace, {
      scheme,
      formatting: {
        label: "${authority}${path}",
        separator: "/",
        tildify: false,
        workspaceSuffix: "",
      },
    });
  } catch {
    // API not available - paths may show with backslashes on Windows
  }
}
