export interface RequiredFieldsPrefs {
  requireProject: boolean;
  requireDescription: boolean;
}

export const REQUIRED_FIELDS_OFF: RequiredFieldsPrefs = {
  requireProject: false,
  requireDescription: false,
};

export interface MissingFields {
  project: boolean;
  description: boolean;
}

/**
 * Pure function: returns which fields are missing given the current prefs and
 * the running entry's values. Idle-resolution entries are always exempt —
 * callers must pass `isIdleResolution: true` for those paths.
 */
export function missingRequiredFields(
  entry: { projectId: string | null; description: string },
  prefs: RequiredFieldsPrefs,
  opts: { isIdleResolution?: boolean } = {},
): MissingFields {
  if (opts.isIdleResolution) {
    return { project: false, description: false };
  }
  return {
    project: prefs.requireProject && entry.projectId === null,
    description: prefs.requireDescription && entry.description.trim() === "",
  };
}

/**
 * Returns `true` when the entry passes all required-field gates (i.e. stop
 * is allowed). Idle-resolution entries always pass.
 */
export function canStop(
  entry: { projectId: string | null; description: string },
  prefs: RequiredFieldsPrefs,
  opts: { isIdleResolution?: boolean } = {},
): boolean {
  const missing = missingRequiredFields(entry, prefs, opts);
  return !missing.project && !missing.description;
}
