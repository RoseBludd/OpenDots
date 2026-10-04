/** Phase 0 seam — R2 per-person folders land in a follow-on WO. */
export interface StorageAdapter {
  /** Prefix like family/<member-slug>/ */
  memberPrefix(memberSlug: string): string;
}

export class LocalStorageAdapter implements StorageAdapter {
  memberPrefix(memberSlug: string) {
    return `family/${memberSlug.replace(/[^a-z0-9-]+/gi, '-').toLowerCase()}/`;
  }
}

export function storageAdapterFromEnv(): StorageAdapter {
  void process.env.FAMILY_R2_BUCKET;
  return new LocalStorageAdapter();
}
