import { describe, expect, it } from "vitest";
import {
  canStop,
  missingRequiredFields,
  REQUIRED_FIELDS_OFF,
} from "./required-fields";

const withProject = { projectId: "p1", description: "Something" };
const withoutProject = { projectId: null, description: "Something" };
const withDescription = { projectId: "p1", description: "Something" };
const withoutDescription = { projectId: "p1", description: "" };
const withBlankDescription = { projectId: "p1", description: "   " };
const bare = { projectId: null, description: "" };

describe("missingRequiredFields", () => {
  describe("both prefs off (default)", () => {
    it("returns no missing fields when project is null", () => {
      expect(
        missingRequiredFields(withoutProject, REQUIRED_FIELDS_OFF),
      ).toEqual({
        project: false,
        description: false,
      });
    });

    it("returns no missing fields when description is empty", () => {
      expect(
        missingRequiredFields(withoutDescription, REQUIRED_FIELDS_OFF),
      ).toEqual({
        project: false,
        description: false,
      });
    });

    it("returns no missing fields for a bare entry", () => {
      expect(missingRequiredFields(bare, REQUIRED_FIELDS_OFF)).toEqual({
        project: false,
        description: false,
      });
    });
  });

  describe("require project only", () => {
    const prefs = { requireProject: true, requireDescription: false };

    it("flags missing project when projectId is null", () => {
      expect(missingRequiredFields(withoutProject, prefs)).toEqual({
        project: true,
        description: false,
      });
    });

    it("does not flag when project is set", () => {
      expect(missingRequiredFields(withProject, prefs)).toEqual({
        project: false,
        description: false,
      });
    });

    it("does not flag missing description even when empty", () => {
      expect(missingRequiredFields(withoutDescription, prefs)).toEqual({
        project: false,
        description: false,
      });
    });
  });

  describe("require description only", () => {
    const prefs = { requireProject: false, requireDescription: true };

    it("flags missing description when empty", () => {
      expect(missingRequiredFields(withoutDescription, prefs)).toEqual({
        project: false,
        description: true,
      });
    });

    it("flags missing description when whitespace only", () => {
      expect(missingRequiredFields(withBlankDescription, prefs)).toEqual({
        project: false,
        description: true,
      });
    });

    it("does not flag when description is non-empty", () => {
      expect(missingRequiredFields(withDescription, prefs)).toEqual({
        project: false,
        description: false,
      });
    });

    it("does not flag missing project even when null", () => {
      expect(missingRequiredFields(withoutProject, prefs)).toEqual({
        project: false,
        description: false,
      });
    });
  });

  describe("both prefs on", () => {
    const prefs = { requireProject: true, requireDescription: true };

    it("flags both when both are missing", () => {
      expect(missingRequiredFields(bare, prefs)).toEqual({
        project: true,
        description: true,
      });
    });

    it("flags only project when only description is filled", () => {
      expect(
        missingRequiredFields({ projectId: null, description: "work" }, prefs),
      ).toEqual({
        project: true,
        description: false,
      });
    });

    it("flags only description when only project is filled", () => {
      expect(
        missingRequiredFields({ projectId: "p1", description: "" }, prefs),
      ).toEqual({
        project: false,
        description: true,
      });
    });

    it("does not flag when both are filled", () => {
      expect(missingRequiredFields(withProject, prefs)).toEqual({
        project: false,
        description: false,
      });
    });
  });

  describe("idle-resolution exemption", () => {
    const prefs = { requireProject: true, requireDescription: true };

    it("returns no missing fields when isIdleResolution is true, even with bare entry", () => {
      expect(
        missingRequiredFields(bare, prefs, { isIdleResolution: true }),
      ).toEqual({
        project: false,
        description: false,
      });
    });

    it("returns no missing fields when isIdleResolution is true and project missing", () => {
      expect(
        missingRequiredFields(withoutProject, prefs, {
          isIdleResolution: true,
        }),
      ).toEqual({
        project: false,
        description: false,
      });
    });

    it("applies normally when isIdleResolution is false", () => {
      expect(
        missingRequiredFields(bare, prefs, { isIdleResolution: false }),
      ).toEqual({
        project: true,
        description: true,
      });
    });
  });
});

describe("canStop", () => {
  describe("both prefs off (default)", () => {
    it("returns true for a bare entry", () => {
      expect(canStop(bare, REQUIRED_FIELDS_OFF)).toBe(true);
    });
  });

  describe("require project only", () => {
    const prefs = { requireProject: true, requireDescription: false };

    it("returns false when project is missing", () => {
      expect(canStop(withoutProject, prefs)).toBe(false);
    });

    it("returns true when project is set", () => {
      expect(canStop(withProject, prefs)).toBe(true);
    });
  });

  describe("require description only", () => {
    const prefs = { requireProject: false, requireDescription: true };

    it("returns false when description is empty", () => {
      expect(canStop(withoutDescription, prefs)).toBe(false);
    });

    it("returns false when description is whitespace only", () => {
      expect(canStop(withBlankDescription, prefs)).toBe(false);
    });

    it("returns true when description is non-empty", () => {
      expect(canStop(withDescription, prefs)).toBe(true);
    });
  });

  describe("both prefs on", () => {
    const prefs = { requireProject: true, requireDescription: true };

    it("returns false when both are missing", () => {
      expect(canStop(bare, prefs)).toBe(false);
    });

    it("returns false when only project is set", () => {
      expect(canStop({ projectId: "p1", description: "" }, prefs)).toBe(false);
    });

    it("returns false when only description is set", () => {
      expect(canStop({ projectId: null, description: "work" }, prefs)).toBe(
        false,
      );
    });

    it("returns true when both are filled", () => {
      expect(canStop(withProject, prefs)).toBe(true);
    });
  });

  describe("idle-resolution exemption", () => {
    const prefs = { requireProject: true, requireDescription: true };

    it("returns true for idle-resolution even with bare entry", () => {
      expect(canStop(bare, prefs, { isIdleResolution: true })).toBe(true);
    });
  });
});
