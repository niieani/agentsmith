import { describe, expect, test } from "bun:test";
import { parseSkillIdentity } from "../src/skills.ts";

describe("skill identity", () => {
  test("reads required metadata", () => {
    const skill = parseSkillIdentity("---\nname: review\ndescription: Review work.\n---\n\nDo it.\n", "/tmp/review", "review");
    expect(skill.name).toBe("review");
    expect(skill.description).toBe("Review work.");
  });

  test("requires directory and public name to agree", () => {
    expect(() => parseSkillIdentity("---\nname: other\ndescription: x\n---\n", "/tmp/review", "review"))
      .toThrow("must match source directory");
  });
});
