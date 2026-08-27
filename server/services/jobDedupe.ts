/** يقارن بصمة SHA-256 للرابط الموحّد قبل إدراج مهمة جديدة. */
export function isChapterRequestDuplicate(existingUrlHash: string, requestedUrlHash: string): boolean {
  return Boolean(existingUrlHash) && existingUrlHash === requestedUrlHash;
}
