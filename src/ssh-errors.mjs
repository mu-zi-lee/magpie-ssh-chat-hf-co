export const isTransientSshError = error =>
  ['ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'EPIPE', 'ENETUNREACH', 'EHOSTUNREACH', 'ETIMEDOUT', 'EAI_AGAIN'].includes(error.code) ||
  /^(Timed out|SSH session closed|Connection lost before handshake)|handshake.*timeout/i.test(error.message);
