/**
 * S3-compatible storage helpers (AWS S3 / MinIO).
 *
 * Environment variables:
 *   AWS_ENDPOINT        - MinIO local: http://localhost:9000 | AWS S3: omit
 *   AWS_REGION          - us-east-1 (any value works for MinIO)
 *   AWS_ACCESS_KEY_ID   - MinIO: MINIO_ROOT_USER
 *   AWS_SECRET_ACCESS_KEY - MinIO: MINIO_ROOT_PASSWORD
 *   AWS_BUCKET          - Bucket name (e.g. gvi-storage)
 *   AWS_PUBLIC_URL      - External access URL (e.g. http://localhost:9000/gvi-storage)
 */

import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  CreateBucketCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import crypto from "node:crypto";

function getS3Config() {
  const bucket = process.env.AWS_BUCKET;
  const region = process.env.AWS_REGION ?? "us-east-1";
  const endpoint = process.env.AWS_ENDPOINT; // MinIO: http://localhost:9000
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;

  if (!bucket) throw new Error("AWS_BUCKET is required");
  if (!accessKeyId) throw new Error("AWS_ACCESS_KEY_ID is required");
  if (!secretAccessKey) throw new Error("AWS_SECRET_ACCESS_KEY is required");

  return { bucket, region, endpoint, accessKeyId, secretAccessKey };
}

let _client: S3Client | null = null;
let _bucket: string | null = null;

function getClient() {
  const config = getS3Config();

  if (!_client) {
    _client = new S3Client({
      region: config.region,
      ...(config.endpoint
        ? {
            endpoint: config.endpoint,
            forcePathStyle: true, // required for MinIO
          }
        : {}),
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    });
    _bucket = config.bucket;
    ensureBucket(_client, config.bucket).catch(err =>
      console.warn("[Storage] Bucket init warning:", err)
    );
  }

  return { client: _client, bucket: _bucket! };
}

async function ensureBucket(client: S3Client, bucket: string) {
  try {
    await client.send(new HeadBucketCommand({ Bucket: bucket }));
  } catch {
    await client.send(new CreateBucketCommand({ Bucket: bucket }));
    console.log(`[Storage] Bucket "${bucket}" created.`);
  }
}

function normalizeKey(relKey: string): string {
  return relKey.replace(/^\/+/, "");
}

function assertSafeKey(relKey: string): string {
  const key = normalizeKey(relKey);
  if (!key || key.includes("..") || key.includes("\\")) {
    throw new Error("Unsafe storage key");
  }
  return key;
}

function appendHashSuffix(relKey: string): string {
  const hash = crypto.randomUUID().replace(/-/g, "").slice(0, 8);
  const lastDot = relKey.lastIndexOf(".");
  if (lastDot === -1) return `${relKey}_${hash}`;
  return `${relKey.slice(0, lastDot)}_${hash}${relKey.slice(lastDot)}`;
}

function getPublicUrl(key: string): string {
  const base = (process.env.AWS_PUBLIC_URL ?? "").replace(/\/+$/, "");
  return base ? `${base}/${key}` : `/storage/${key}`;
}

export async function storagePut(
  relKey: string,
  data: Buffer | Uint8Array | string,
  contentType = "application/octet-stream"
): Promise<{ key: string; url: string }> {
  const { client, bucket } = getClient();
  const key = appendHashSuffix(normalizeKey(relKey));

  const body = typeof data === "string" ? Buffer.from(data, "utf-8") : data;

  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: contentType,
    })
  );

  return { key, url: getPublicUrl(key) };
}

export async function storageCreateUploadUrl(
  relKey: string
): Promise<{ key: string; uploadUrl: string; accessUrl: string }> {
  const { client, bucket } = getClient();
  const key = assertSafeKey(relKey);

  const command = new PutObjectCommand({ Bucket: bucket, Key: key });
  const uploadUrl = await getSignedUrl(client, command, { expiresIn: 3600 });

  return { key, uploadUrl, accessUrl: getPublicUrl(key) };
}

export async function storageGet(
  relKey: string
): Promise<{ key: string; url: string }> {
  const key = normalizeKey(relKey);
  return { key, url: getPublicUrl(key) };
}

/**
 * Read an object's body as text.
 *
 * Used for curation documents, which are served through tRPC rather than a signed
 * URL so tenant checks and contract validation happen before anything reaches the
 * browser.
 */
export async function storageGetText(relKey: string): Promise<string> {
  const { client, bucket } = getClient();
  const key = assertSafeKey(relKey);

  const result = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  if (!result.Body) throw new Error(`Storage object has no body: ${key}`);
  return result.Body.transformToString("utf-8");
}

export async function storageGetSignedUrl(relKey: string): Promise<string> {
  const { client, bucket } = getClient();
  const key = assertSafeKey(relKey);

  const command = new GetObjectCommand({ Bucket: bucket, Key: key });
  return getSignedUrl(client, command, { expiresIn: 3600 });
}
