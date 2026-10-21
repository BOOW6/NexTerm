import { downloadSftp, uploadSftp, type SftpConflictPolicy } from '../hooks/useTauriSsh';
import {
  useTransferStore,
  type TransferDirection,
  type TransferItem
} from '../stores/transferStore';

export interface StartSftpTransferPayload {
  sshId: string;
  direction: TransferDirection;
  name: string;
  localPath: string;
  remotePath: string;
  recursive?: boolean;
  conflict?: SftpConflictPolicy;
  resume?: boolean;
}

export async function startSftpTransfer(payload: StartSftpTransferPayload): Promise<string> {
  const options = {
    recursive: payload.recursive ?? false,
    resume: payload.resume ?? true,
    conflict: payload.conflict ?? 'overwrite'
  };

  const id =
    payload.direction === 'upload'
      ? await uploadSftp(payload.sshId, payload.localPath, payload.remotePath, options)
      : await downloadSftp(payload.sshId, payload.remotePath, payload.localPath, options);

  useTransferStore.getState().begin({
    id,
    name: payload.name,
    direction: payload.direction,
    request: {
      sshId: payload.sshId,
      localPath: payload.localPath,
      remotePath: payload.remotePath,
      ...options
    }
  });

  return id;
}

export async function retryTransfer(item: TransferItem): Promise<string | null> {
  if (!item.request) {
    return null;
  }

  return startSftpTransfer({
    sshId: item.request.sshId,
    direction: item.direction,
    name: item.name,
    localPath: item.request.localPath,
    remotePath: item.request.remotePath,
    recursive: item.request.recursive,
    conflict: item.request.conflict,
    resume: item.request.resume
  });
}
