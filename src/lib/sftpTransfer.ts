import { downloadSftp, uploadSftp, type SftpConflictPolicy } from '../hooks/useTauriSsh';
import { useConnectionStore } from '../stores/connectionStore';
import {
  useTransferStore,
  type TransferDirection,
  type TransferItem,
  type TransferRequest
} from '../stores/transferStore';

export interface StartSftpTransferPayload {
  sessionId: string;
  direction: TransferDirection;
  name: string;
  localPath: string;
  remotePath: string;
  recursive?: boolean;
  conflict?: SftpConflictPolicy;
  resume?: boolean;
}

function connectedSshId(sessionId: string): string | null {
  const connection = useConnectionStore.getState().connections[sessionId];
  return connection && connection.status === 'connected' ? connection.sshId : null;
}

export async function startSftpTransfer(payload: StartSftpTransferPayload): Promise<string> {
  // Resolve the backend connection id at call time: it changes on every
  // reconnect, so it must never be stored on the retry request.
  const sshId = connectedSshId(payload.sessionId);
  if (!sshId) {
    throw new Error('会话尚未建立 SSH 连接，无法传输');
  }

  const options = {
    recursive: payload.recursive ?? false,
    resume: payload.resume ?? true,
    conflict: payload.conflict ?? 'overwrite'
  };

  const id =
    payload.direction === 'upload'
      ? await uploadSftp(sshId, payload.localPath, payload.remotePath, options)
      : await downloadSftp(sshId, payload.remotePath, payload.localPath, options);

  useTransferStore.getState().begin({
    id,
    name: payload.name,
    direction: payload.direction,
    request: {
      sessionId: payload.sessionId,
      localPath: payload.localPath,
      remotePath: payload.remotePath,
      ...options
    }
  });

  return id;
}

export async function retryTransfer(item: TransferItem): Promise<string | null> {
  const request: TransferRequest | undefined = item.request;
  if (!request) {
    return null;
  }
  if (!connectedSshId(request.sessionId)) {
    throw new Error('会话未连接，重连后将自动续传');
  }

  const id = await startSftpTransfer({
    sessionId: request.sessionId,
    direction: item.direction,
    name: item.name,
    localPath: request.localPath,
    remotePath: request.remotePath,
    recursive: request.recursive,
    conflict: request.conflict,
    resume: request.resume
  });
  useTransferStore.getState().remove(item.id);
  return id;
}

/**
 * Restart transfers that were interrupted by a connection drop once the
 * session's SSH transport is back. The backend resumes from the `.part`
 * files via their sidecar fingerprints, so completed data is never resent.
 */
export async function resumeInterruptedTransfers(sessionId: string): Promise<number> {
  const { transfers, remove } = useTransferStore.getState();
  const interrupted = transfers.filter(
    (item) => item.status === 'interrupted' && item.request?.sessionId === sessionId
  );

  let resumed = 0;
  for (const item of interrupted) {
    const request = item.request;
    if (!request) {
      continue;
    }
    try {
      await startSftpTransfer({
        sessionId,
        direction: item.direction,
        name: item.name,
        localPath: request.localPath,
        remotePath: request.remotePath,
        recursive: request.recursive,
        conflict: request.conflict,
        resume: request.resume
      });
      remove(item.id);
      resumed += 1;
    } catch {
      // Session not connected (or the backend refused): keep the entry
      // interrupted so the next reconnect picks it up again.
      break;
    }
  }
  return resumed;
}
