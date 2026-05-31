/**
 * Alignment Node Quorum — simulated decentralized oversight layer.
 *
 * 0G markets AI Alignment Nodes as the oversight tier for decentralized AI,
 * but almost no project integrates them yet. zer0Gig V1 settles milestones
 * with a SINGLE alignmentNodeVerifier key (the honest gap called out in the
 * V1 → V3 roadmap). This module previews the V1.5 direction: high-value
 * milestones are independently attested by a quorum of Alignment Nodes
 * before payout.
 *
 * IMPORTANT — honesty: the node identities here are DETERMINISTIC STUBS
 * derived from a fixed seed (no secrets, stable across restarts). The ECDSA
 * signatures they produce are cryptographically REAL and verifiable; only the
 * node *operators* are simulated until the live network exists. Every result
 * is tagged `simulated: true` so nothing downstream can misrepresent it.
 */

import { ethers } from "ethers";

const NODE_COUNT  = Number(process.env.ALIGNMENT_NODE_COUNT)      || 5;
const QUORUM      = Number(process.env.ALIGNMENT_NODE_QUORUM)     || 3;   // 3-of-5
const PASS_SCORE  = Number(process.env.ALIGNMENT_NODE_PASS_SCORE) || 8000; // bps (0–10000)
const SEED        = process.env.ALIGNMENT_NODE_SEED || "zer0gig-alignment-node";

/**
 * Deterministic per-node wallet derived from the seed. Stable across process
 * restarts; carries no real funds and signs only attestation digests.
 */
function nodeWallet(i) {
  const pk = ethers.keccak256(ethers.toUtf8Bytes(`${SEED}:node:${i}`));
  return new ethers.Wallet(pk);
}

/** Public roster of simulated Alignment Node addresses. */
export function alignmentNodeRoster() {
  return Array.from({ length: NODE_COUNT }, (_, i) => nodeWallet(i).address);
}

/**
 * Request attestation from the simulated Alignment Node quorum.
 *
 * Each node re-derives the alignment digest and signs it iff the milestone's
 * alignment score clears the pass threshold (stub policy — a live node would
 * re-run an independent evaluation of the deliverable). Attestation succeeds
 * when at least QUORUM nodes sign.
 *
 * @returns {Promise<{attested:boolean, quorum:string, quorumRequired:number,
 *   attestationId:string, digest:string, attestors:string[],
 *   signatures:string[], passScore:number, alignmentScore:number,
 *   simulated:true}>}
 */
export async function requestAlignmentAttestation({ jobId, milestoneIndex, outputHash, alignmentScore }) {
  // Domain-separated digest — distinct from the on-chain release signature so
  // an attestation can never be replayed as a verifier signature.
  const digest = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["uint256", "uint8", "uint16", "bytes32", "string"],
      [jobId, milestoneIndex, alignmentScore, outputHash, "0g-alignment-attestation-v1"]
    )
  );

  const roster = [];
  for (let i = 0; i < NODE_COUNT; i++) {
    const w = nodeWallet(i);
    const attests = alignmentScore >= PASS_SCORE;
    roster.push({
      address: w.address,
      attested: attests,
      signature: attests ? await w.signMessage(ethers.getBytes(digest)) : null,
    });
  }

  const signed = roster.filter(n => n.attested);
  const attested = signed.length >= QUORUM;
  const attestationId = ethers.keccak256(
    ethers.toUtf8Bytes(`${jobId.toString()}:${milestoneIndex}:${outputHash}:${signed.length}`)
  );

  return {
    attested,
    quorum: `${signed.length}/${NODE_COUNT}`,
    quorumRequired: QUORUM,
    attestationId,
    digest,
    attestors: signed.map(n => n.address),
    signatures: signed.map(n => n.signature),
    passScore: PASS_SCORE,
    alignmentScore,
    simulated: true,
  };
}
