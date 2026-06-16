import { keccak256, stringToHex, verifyMessage, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { canonicalize, type Constitution } from "./constitution.js";

/**
 * Turns the constitution into a *contract*: the signer commits to a specific policy,
 * and any later tampering invalidates the signature. The digest is keccak256 over the
 * canonical (signature-stripped, key-sorted) JSON, signed with EIP-191 personal_sign
 * — the same scheme a Trust Wallet user would sign with, tying the policy to the
 * agent owner's address.
 */
export function constitutionDigest(c: Constitution): Hex {
  return keccak256(stringToHex(canonicalize(c)));
}

/** Sign a constitution with the owner's private key. Returns a copy with `signature` populated. */
export async function signConstitution(c: Constitution, privateKey: Hex): Promise<Constitution> {
  const account = privateKeyToAccount(privateKey);
  const digest = constitutionDigest(c);
  const value = await account.signMessage({ message: digest });
  return {
    ...c,
    signature: { scheme: "eip191-personal-sign", signer: account.address, value },
  };
}

export interface VerificationResult {
  valid: boolean;
  reason?: string;
}

/**
 * Verify a constitution's signature. Optionally require that the signer matches the
 * governed wallet (`requireSignerIsWallet`) so a policy can only be signed by the
 * account that owns the agent wallet.
 */
export async function verifyConstitution(
  c: Constitution,
  opts: { requireSignerIsWallet?: boolean } = {},
): Promise<VerificationResult> {
  if (!c.signature) return { valid: false, reason: "unsigned" };
  if (opts.requireSignerIsWallet && c.signature.signer.toLowerCase() !== c.walletAddress.toLowerCase()) {
    return { valid: false, reason: "signer is not the governed wallet" };
  }
  const digest = constitutionDigest(c);
  const valid = await verifyMessage({
    address: c.signature.signer as Hex,
    message: digest,
    signature: c.signature.value as Hex,
  });
  return valid ? { valid: true } : { valid: false, reason: "signature does not match canonical digest" };
}
