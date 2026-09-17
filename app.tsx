import { useEffect, useState, type ReactNode } from "react";
import {
  definePluginApp,
  useBbNavigate,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import type { OpenForThreadResult, rpcContract } from "./server";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";

const PANEL_ACTION_ID = "px0-navigator";

type PanelState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | OpenForThreadResult;

function PanelMessage({
  children,
  error = false,
}: {
  children: ReactNode;
  error?: boolean;
}) {
  return (
    <div className="flex h-full min-h-0 w-full items-center justify-center bg-background p-6">
      <p
        className={
          error
            ? "max-w-md text-center text-sm text-destructive"
            : "max-w-md text-center text-sm text-muted-foreground"
        }
      >
        {children}
      </p>
    </div>
  );
}

function Px0Panel({ threadId }: { threadId: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const [state, setState] = useState<PanelState>({ status: "loading" });

  useEffect(() => {
    let active = true;
    setState({ status: "loading" });
    rpc.call("open_for_thread", { threadId }).then(
      (result) => {
        if (active) setState(result);
      },
      (cause: unknown) => {
        if (!active) return;
        setState({
          status: "error",
          message: cause instanceof Error ? cause.message : String(cause),
        });
      },
    );
    return () => {
      active = false;
    };
  }, [rpc, threadId]);

  if (state.status === "loading") {
    return (
      <div
        role="status"
        className="flex h-full min-h-0 w-full flex-col items-center justify-center gap-3 bg-background p-6 text-sm text-muted-foreground"
      >
        <Icon name="Spinner" className="size-5 animate-spin" />
        <span>Starting px0 and indexing this workspace…</span>
      </div>
    );
  }

  if (state.status === "error") {
    return <PanelMessage error>{state.message}</PanelMessage>;
  }

  if (state.status === "unavailable") {
    return <PanelMessage>{state.message}</PanelMessage>;
  }

  const isLocal =
    window.location.hostname === "localhost" ||
    window.location.hostname === "127.0.0.1";
  const url = isLocal ? state.localUrl : state.shareUrl;

  if (url === null) {
    return (
      <PanelMessage>
        px0 is running on the workspace machine, but this remote BB client
        cannot reach it. Enroll that machine in BB Connect, then reopen this
        panel.
      </PanelMessage>
    );
  }

  return (
    <iframe
      className="h-full min-h-0 w-full border-0 bg-background"
      src={url}
      title={`px0 code navigator for ${state.path}`}
    />
  );
}

function Px0HeaderAction({
  isCompactViewport,
}: {
  threadId: string;
  projectId: string;
  isCompactViewport: boolean;
}) {
  const navigate = useBbNavigate();
  return (
    <Button
      type="button"
      variant="ghost"
      size={isCompactViewport ? "icon" : "sm"}
      className="h-7"
      aria-label="Open px0 code navigator"
      onClick={() => {
        navigate.openThreadPanel({ actionId: PANEL_ACTION_ID });
      }}
    >
      <Icon name="Folder" className="size-4" />
      {isCompactViewport ? null : <span>px0</span>}
    </Button>
  );
}

export default definePluginApp((app) => {
  app.slots.threadPanelAction({
    id: PANEL_ACTION_ID,
    title: "px0",
    icon: "FolderOpen",
    layout: "flush",
    component: Px0Panel,
  });

  app.slots.experimental_threadHeaderAction({
    id: "open-px0",
    title: "px0",
    component: Px0HeaderAction,
  });
});
