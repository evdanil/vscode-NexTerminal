import * as vscode from "vscode";
import type { SessionSnapshot } from "../core/contracts";
import { renderTunnelMonitorHtml } from "./tunnelMonitorHtml";

export class TunnelMonitorViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "nexusTunnelMonitor";
  private snapshot: SessionSnapshot = {
    servers: [],
    tunnels: [],
    serialProfiles: [],
    activeSessions: [],
    activeSerialSessions: [],
    activeTunnels: []
  };
  private view?: vscode.WebviewView;

  public setSnapshot(snapshot: SessionSnapshot): void {
    this.snapshot = snapshot;
    this.refresh();
  }

  public resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: false
    };
    this.refresh();
  }

  private refresh(): void {
    if (!this.view) {
      return;
    }
    this.view.webview.html = renderTunnelMonitorHtml(this.snapshot);
  }
}
