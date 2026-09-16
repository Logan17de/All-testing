import { describe, expect, it } from "vitest";

import { runtimeMemoryPath, runtimeProjectMemoriesPath } from "./memory-routes";

const ID = "01890a5d-ac96-774b-bcce-b302099a8057";
const OTHER = "01890a5d-ac96-774b-bcce-b302099a8058";

describe("memory proxy paths", () => {
  it("keeps only the query parameters the memory list understands", () => {
    expect(
      runtimeProjectMemoriesPath(ID, new URLSearchParams("q=budget&kind=decision&pinned=true")),
    ).toBe(`/api/projects/${ID}/memories?pinned=true&kind=decision&q=budget`);
    expect(runtimeProjectMemoriesPath(ID, new URLSearchParams("limit=5&projectId=other"))).toBe(
      `/api/projects/${ID}/memories?limit=5`,
    );
    expect(runtimeProjectMemoriesPath(ID, new URLSearchParams())).toBe(
      `/api/projects/${ID}/memories`,
    );
  });

  it("takes a repeated parameter once, so the runtime sees one value", () => {
    expect(runtimeProjectMemoriesPath(ID, new URLSearchParams("kind=note&kind=fact"))).toBe(
      `/api/projects/${ID}/memories?kind=note`,
    );
  });

  it("drops an empty value rather than sending one the runtime refuses", () => {
    expect(runtimeProjectMemoriesPath(ID, new URLSearchParams("q="))).toBe(
      `/api/projects/${ID}/memories`,
    );
  });

  it("refuses anything that is not one of the runtime's ids", () => {
    for (const id of ["", "not-an-id", `${ID}/archive`, "../runs", `${ID} `, ID.toUpperCase()]) {
      expect(runtimeProjectMemoriesPath(id, new URLSearchParams())).toBeUndefined();
      expect(runtimeMemoryPath(id)).toBeUndefined();
    }
  });

  it("maps one memory to its runtime endpoint", () => {
    expect(runtimeMemoryPath(OTHER)).toBe(`/api/memories/${OTHER}`);
  });
});
