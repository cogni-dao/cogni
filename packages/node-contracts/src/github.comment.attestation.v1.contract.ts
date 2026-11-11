// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@contracts/github.comment.attestation.v1`
 * Purpose: Shared relying-party contract for operator-signed reads of ONE public GitHub issue comment (task.0095).
 * Scope: Pure Zod wire schemas and the pinned protocol descriptor. Does not sign or verify tokens, read GitHub,
 *   access environment/framework state, or decide a proof. The node decides; the operator only signs facts.
 * Invariants:
 *   - FROZEN_PROTOCOL_FINGERPRINT: the signed claims carry the pinned v1 descriptor hash. Operator and node-template
 *     hold a byte-identical copy of this file and the same vectors; a semantic change needs a v2 contract.
 *   - NO_TARGET_ORIGIN: the request has no origin. The echoed `requestNonce`, the audience and the pinned issuer bind
 *     an answer to one call by one node.
 *   - TYPE_SEPARATION: the header `typ` and the claim `type` differ from `identity.attestation.v1`, and both claim
 *     schemas are strict, so a token of one type never passes as the other.
 *   - NO_SECRET_IN_REQUEST: the request never carries the challenge secret.
 *   - PROOF_LINES_ONLY: the answer returns at most 5 proof lines of the body, never the whole body.
 * Side-effects: none
 * Links: task.0095, node-template inbox contrib-flock-leader-conductor-b42643a0 (operator-proof-comment-reader)
 * @public
 */

import { z } from "zod";

import {
	IdentityAttestationAudienceSchema,
	IdentityAttestationNodeIdSchema,
	IdentityAttestationOriginSchema,
	identityAttestationAudience,
} from "./identity.attestation.v1.contract";

export const GITHUB_COMMENT_ATTESTATION_V1 =
	"github.comment.attestation.v1" as const;
/** JWT header `typ`. `identity.attestation.v1` uses `JWT`. */
export const GITHUB_COMMENT_ATTESTATION_TYP =
	"github.comment.attestation+jwt" as const;
/** Lifetime of a signed answer. */
export const GITHUB_COMMENT_ATTESTATION_TTL_SECONDS = 120;
/** The node refuses an answer whose `readAt` is more than this many seconds older than `iat`. */
export const GITHUB_COMMENT_ATTESTATION_MAX_READ_AGE_SECONDS = 60;

/**
 * Frozen, cross-repository protocol descriptor. Operator and node-template CI hash this JSON value and pin the
 * digest below.
 */
export const GITHUB_COMMENT_ATTESTATION_V1_PROTOCOL = {
	id: GITHUB_COMMENT_ATTESTATION_V1,
	algorithm: "EdDSA",
	typ: GITHUB_COMMENT_ATTESTATION_TYP,
	ttlSeconds: GITHUB_COMMENT_ATTESTATION_TTL_SECONDS,
	maxReadAgeSeconds: GITHUB_COMMENT_ATTESTATION_MAX_READ_AGE_SECONDS,
	audience: "urn:cogni:node:<node UUID>",
	request: ["nodeId", "requestNonce", "issue", "commentId"],
	claims: [
		"type",
		"protocol",
		"iss",
		"aud",
		"nodeId",
		"requestNonce",
		"result",
		"readAt",
		"comment",
		"iat",
		"exp",
		"jti",
	],
	comment: [
		"repo",
		"issueNumber",
		"issueUrl",
		"commentId",
		"userId",
		"userType",
		"login",
		"createdAt",
		"updatedAt",
		"lastEditedAt",
		"proofLines",
	],
	rules: [
		"strict objects",
		"request has no targetOrigin and never carries the challenge secret",
		"protocol fingerprint is required in signed claims",
		"issuer is a canonical HTTPS origin without credentials",
		"audience is derived from nodeId",
		"requestNonce is URL-safe and 32..128 characters and is echoed",
		"readAt is epoch seconds and is not later than iat plus 5",
		"result found carries a comment; result not_found carries comment null",
		"comment.issueUrl is the actual issue of the comment",
		"comment.lastEditedAt is a string or null, never absent",
		"at most 5 proof lines, never the whole body",
		"expiration is later than issuance",
	],
} as const;

export const GITHUB_COMMENT_ATTESTATION_V1_PROTOCOL_SHA256 =
	"b23898a6722db468cb3b445aca2d7d2b4941bb98fd42a50e6322839fa3aed50e" as const;

/** Opaque, URL-safe nonce minted by the node for one operator call. */
export const GithubCommentAttestationRequestNonceSchema = z
	.string()
	.min(32)
	.max(128)
	.regex(/^[A-Za-z0-9_-]+$/);

/** `owner/repo#number`, as in a node's `AGENT_PROOF_ISSUES` entry. */
export const GithubCommentAttestationIssueSchema = z
	.string()
	.regex(
		/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}#[1-9][0-9]{0,9}$/,
	);

export const GithubCommentAttestationCommentIdSchema = z
	.number()
	.int()
	.positive()
	.refine(Number.isSafeInteger);

export const GithubCommentAttestationRequestSchema = z
	.object({
		nodeId: IdentityAttestationNodeIdSchema,
		requestNonce: GithubCommentAttestationRequestNonceSchema,
		issue: GithubCommentAttestationIssueSchema,
		commentId: GithubCommentAttestationCommentIdSchema,
	})
	.strict();

const IsoTimestampSchema = z.string().datetime().max(40);

export const GithubCommentAttestationCommentSchema = z
	.object({
		/** `owner/repo`, lowercase. */
		repo: z.string().min(3).max(140),
		issueNumber: z.number().int().positive(),
		/** The ACTUAL issue of the comment (GitHub `issue_url`), passed through, not the one asked for. */
		issueUrl: z
			.string()
			.regex(
				/^https:\/\/api\.github\.com\/repos\/[^/\s]+\/[^/\s]+\/issues\/[1-9][0-9]*$/,
			),
		commentId: GithubCommentAttestationCommentIdSchema,
		/** GitHub numeric user id, or null when the author is gone. */
		userId: z.number().int().positive().nullable(),
		userType: z.string().min(1).max(32).nullable(),
		login: z.string().min(1).max(64).nullable(),
		createdAt: IsoTimestampSchema,
		updatedAt: IsoTimestampSchema,
		/** GraphQL `lastEditedAt`: null = never edited. Always present in a good answer. */
		lastEditedAt: IsoTimestampSchema.nullable(),
		/** At most 5 body lines that look like a proof line. Never the whole body. */
		proofLines: z.array(z.string().min(1).max(300)).max(5),
	})
	.strict();

export const GithubCommentAttestationClaimsSchema = z
	.object({
		type: z.literal(GITHUB_COMMENT_ATTESTATION_V1),
		protocol: z.literal(GITHUB_COMMENT_ATTESTATION_V1_PROTOCOL_SHA256),
		iss: IdentityAttestationOriginSchema,
		aud: IdentityAttestationAudienceSchema,
		nodeId: IdentityAttestationNodeIdSchema,
		requestNonce: GithubCommentAttestationRequestNonceSchema,
		result: z.enum(["found", "not_found"]),
		/** Epoch seconds when the operator read GitHub. A cached read is older than `iat`. */
		readAt: z.number().int().nonnegative(),
		comment: GithubCommentAttestationCommentSchema.nullable(),
		iat: z.number().int().nonnegative(),
		exp: z.number().int().positive(),
		jti: z.string().uuid(),
	})
	.strict()
	.superRefine((claims, ctx) => {
		if (claims.aud !== identityAttestationAudience(claims.nodeId)) {
			ctx.addIssue({
				code: "custom",
				path: ["aud"],
				message: "aud must be derived from nodeId",
			});
		}
		if (claims.exp <= claims.iat) {
			ctx.addIssue({
				code: "custom",
				path: ["exp"],
				message: "exp must be later than iat",
			});
		}
		if ((claims.result === "found") !== (claims.comment !== null)) {
			ctx.addIssue({
				code: "custom",
				path: ["comment"],
				message: "comment is present exactly when result is found",
			});
		}
	});

export type GithubCommentAttestationRequest = z.infer<
	typeof GithubCommentAttestationRequestSchema
>;
export type GithubCommentAttestationClaims = z.infer<
	typeof GithubCommentAttestationClaimsSchema
>;
