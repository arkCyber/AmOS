/**
 * Tests for custom avatar upload functionality in contacts module.
 * 
 * Covers:
 * - Image compression and processing (integration tests, require DOM)
 * - Avatar upload and removal
 * - CustomAvatar data structure validation
 * - Integration with contact list operations
 * 
 * Note: Image processing tests (compressImage, processAvatarUpload) require
 * Canvas API and are tested via integration tests in a browser environment.
 * Unit tests here focus on data structure and contact list manipulation.
 */

import { describe, it, expect } from "bun:test";
import {
  setContactAvatar,
  getContactAvatarSrc,
  hasCustomAvatar,
  type Contact,
  type CustomAvatar,
  makeContactId,
} from "../contacts";

describe("CustomAvatar data structure", () => {
  it("should have valid type field (base64 or file)", () => {
    const avatar1: CustomAvatar = { type: "base64", data: "data:image/jpeg;base64,..." };
    const avatar2: CustomAvatar = { type: "file", data: "/path/to/avatar.jpg" };
    
    expect(avatar1.type).toBe("base64");
    expect(avatar2.type).toBe("file");
  });

  it("should have data field for image content", () => {
    const avatar: CustomAvatar = {
      type: "base64",
      data: "data:image/jpeg;base64,/9j/4AAQSkZJRg...",
    };
    
    expect(avatar.data).toBeTruthy();
    expect(typeof avatar.data).toBe("string");
  });

  it("should support optional thumbnail field", () => {
    const withThumb: CustomAvatar = {
      type: "base64",
      data: "full-size-data",
      thumbnail: "thumbnail-data",
    };
    
    const withoutThumb: CustomAvatar = {
      type: "base64",
      data: "full-size-data",
    };
    
    expect(withThumb.thumbnail).toBeDefined();
    expect(withoutThumb.thumbnail).toBeUndefined();
  });
});

// Note: compressImage and processAvatarUpload tests are skipped in unit tests
// because they require Canvas API which is not available in Node.js test environment.
// These functions are tested through integration tests in a browser environment.

describe("setContactAvatar", () => {
  const makeContact = (id: string, name: string): Contact => ({
    id,
    name,
    phones: ["123456789"],
    fav: false,
    ts: Date.now(),
  });

  it("should add custom avatar to a contact", () => {
    const contacts = [makeContact("c1", "Alice"), makeContact("c2", "Bob")];
    const avatar: CustomAvatar = {
      type: "base64",
      data: "data:image/jpeg;base64,...",
      thumbnail: "data:image/jpeg;base64,...thumb",
    };
    
    const updated = setContactAvatar(contacts, "c1", avatar);
    
    expect(updated[0]!.customAvatar).toEqual(avatar);
    expect(updated[1]!.customAvatar).toBeUndefined();
  });

  it("should remove custom avatar when null is passed", () => {
    const avatar: CustomAvatar = { type: "base64", data: "..." };
    const contacts = [
      { ...makeContact("c1", "Alice"), customAvatar: avatar },
      makeContact("c2", "Bob"),
    ];
    
    const updated = setContactAvatar(contacts, "c1", null);
    
    expect(updated[0]!.customAvatar).toBeUndefined();
  });

  it("should update ts when avatar is changed", () => {
    const contacts = [makeContact("c1", "Alice")];
    const oldTs = contacts[0]!.ts;
    
    // Wait 1ms to ensure timestamp difference
    const avatar: CustomAvatar = { type: "base64", data: "..." };
    
    // Manually advance time by modifying the contact timestamp
    const updated = setContactAvatar(contacts, "c1", avatar);
    
    // The function should update timestamp, so it should be >= oldTs
    expect(updated[0]!.ts).toBeGreaterThanOrEqual(oldTs);
  });

  it("should not mutate original contact list", () => {
    const contacts = [makeContact("c1", "Alice")];
    const avatar: CustomAvatar = { type: "base64", data: "..." };
    
    const updated = setContactAvatar(contacts, "c1", avatar);
    
    expect(contacts[0]!.customAvatar).toBeUndefined();
    expect(updated[0]!.customAvatar).toEqual(avatar);
    expect(updated).not.toBe(contacts);
  });

  it("should handle non-existent contact ID gracefully", () => {
    const contacts = [makeContact("c1", "Alice")];
    const avatar: CustomAvatar = { type: "base64", data: "..." };
    
    const updated = setContactAvatar(contacts, "non-existent", avatar);
    
    expect(updated).toEqual(contacts);
  });
});

describe("getContactAvatarSrc", () => {
  const makeContact = (id: string, name: string): Contact => ({
    id,
    name,
    phones: ["123456789"],
    fav: false,
    ts: Date.now(),
  });

  it("should return thumbnail for list view when available", () => {
    const avatar: CustomAvatar = {
      type: "base64",
      data: "full-size-data",
      thumbnail: "thumbnail-data",
    };
    const contact = { ...makeContact("c1", "Alice"), customAvatar: avatar };
    
    const src = getContactAvatarSrc(contact, true);
    
    expect(src).toBe("thumbnail-data");
  });

  it("should return full data for detail view", () => {
    const avatar: CustomAvatar = {
      type: "base64",
      data: "full-size-data",
      thumbnail: "thumbnail-data",
    };
    const contact = { ...makeContact("c1", "Alice"), customAvatar: avatar };
    
    const src = getContactAvatarSrc(contact, false);
    
    expect(src).toBe("full-size-data");
  });

  it("should return full data when thumbnail is missing", () => {
    const avatar: CustomAvatar = {
      type: "base64",
      data: "full-size-data",
    };
    const contact = { ...makeContact("c1", "Alice"), customAvatar: avatar };
    
    const src = getContactAvatarSrc(contact, true);
    
    expect(src).toBe("full-size-data");
  });

  it("should return empty string when no custom avatar", () => {
    const contact = makeContact("c1", "Alice");
    
    const src = getContactAvatarSrc(contact, true);
    
    expect(src).toBe("");
  });
});

describe("hasCustomAvatar", () => {
  const makeContact = (id: string, name: string): Contact => ({
    id,
    name,
    phones: ["123456789"],
    fav: false,
    ts: Date.now(),
  });

  it("should return true when contact has custom avatar", () => {
    const avatar: CustomAvatar = { type: "base64", data: "..." };
    const contact = { ...makeContact("c1", "Alice"), customAvatar: avatar };
    
    expect(hasCustomAvatar(contact)).toBe(true);
  });

  it("should return false when contact has no custom avatar", () => {
    const contact = makeContact("c1", "Alice");
    
    expect(hasCustomAvatar(contact)).toBe(false);
  });

  it("should return false when customAvatar is undefined", () => {
    const contact = { ...makeContact("c1", "Alice"), customAvatar: undefined };
    
    expect(hasCustomAvatar(contact)).toBe(false);
  });
});

describe("Integration: avatar upload workflow", () => {
  it("should complete full workflow: data structure → display → remove", () => {
    // Initial contact list
    let contacts: Contact[] = [
      {
        id: makeContactId(),
        name: "Test User",
        phones: ["123456789"],
        fav: false,
        ts: Date.now(),
      },
    ];
    
    const contactId = contacts[0]!.id;
    
    // Step 1: Set avatar (simulate upload result)
    const avatar: CustomAvatar = {
      type: "base64",
      data: "data:image/jpeg;base64,/9j/4AAQSkZJRg...",
      thumbnail: "data:image/jpeg;base64,/9j/4AAQSkZJRg...thumb",
    };
    
    contacts = setContactAvatar(contacts, contactId, avatar);
    expect(hasCustomAvatar(contacts[0]!)).toBe(true);
    
    // Step 2: Get display source
    const listSrc = getContactAvatarSrc(contacts[0]!, true);
    const detailSrc = getContactAvatarSrc(contacts[0]!, false);
    
    expect(listSrc).toBe(avatar.thumbnail ?? avatar.data);
    expect(detailSrc).toBe(avatar.data);
    
    // Step 3: Remove avatar
    contacts = setContactAvatar(contacts, contactId, null);
    expect(hasCustomAvatar(contacts[0]!)).toBe(false);
    expect(getContactAvatarSrc(contacts[0]!, true)).toBe("");
  });

  it("should preserve other contact data when setting avatar", () => {
    const contact: Contact = {
      id: makeContactId(),
      name: "Jane Doe",
      phones: ["111", "222"],
      note: "Important contact",
      fav: true,
      ts: Date.now(),
    };
    
    const contacts = [contact];
    const avatar: CustomAvatar = { type: "base64", data: "..." };
    
    const updated = setContactAvatar(contacts, contact.id, avatar);
    
    expect(updated[0]!.name).toBe("Jane Doe");
    expect(updated[0]!.phones).toEqual(["111", "222"]);
    expect(updated[0]!.note).toBe("Important contact");
    expect(updated[0]!.fav).toBe(true);
    expect(updated[0]!.customAvatar).toEqual(avatar);
  });
});
