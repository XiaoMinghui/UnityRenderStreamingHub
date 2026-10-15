export default interface Options {
  secure?: boolean;
  port?: number;
  keyfile?: string;
  certfile?: string;
  type?: string;
  mode?: string;
  logging?: string;
  pool?: boolean;
  poolToken?: string;
  admin?: boolean;
  adminToken?: string;
  agents?: boolean;
  agentToken?: string;
}
