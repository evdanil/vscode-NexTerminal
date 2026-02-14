export interface RpcRequest {
  id: string;
  method: string;
  params?: unknown;
}

export interface RpcError {
  message: string;
}

export interface RpcResponse {
  id: string;
  result?: unknown;
  error?: RpcError;
}

export interface RpcNotification {
  method: string;
  params?: unknown;
}

export interface SerialPortInfo {
  path: string;
  manufacturer?: string;
  serialNumber?: string;
  vendorId?: string;
  productId?: string;
}

export interface OpenPortParams {
  path: string;
  baudRate: number;
}

export interface OpenPortResult {
  sessionId: string;
}
