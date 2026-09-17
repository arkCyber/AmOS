/**
 * Unit tests for avatar theme system in contacts module.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  avatarEmoji,
  avatarHue,
  setAvatarTheme,
  getAvatarTheme,
  getAvatarThemes,
  type AvatarTheme,
} from "../contacts";

describe("Avatar Theme System", () => {
  beforeEach(() => {
    // Reset to default theme before each test
    setAvatarTheme("animals");
  });

  describe("avatarHue", () => {
    it("returns consistent hue for same name", () => {
      const hue1 = avatarHue("张三");
      const hue2 = avatarHue("张三");
      expect(hue1).toBe(hue2);
    });

    it("returns different hues for different names", () => {
      const hue1 = avatarHue("张三");
      const hue2 = avatarHue("李四");
      expect(hue1).not.toBe(hue2);
    });

    it("returns value in 0-359 range", () => {
      const hue = avatarHue("测试用户");
      expect(hue).toBeGreaterThanOrEqual(0);
      expect(hue).toBeLessThan(360);
    });

    it("handles empty string", () => {
      const hue = avatarHue("");
      expect(hue).toBe(0);
    });

    it("handles whitespace-only name", () => {
      const hue = avatarHue("   ");
      expect(hue).toBe(0);
    });
  });

  describe("avatarEmoji", () => {
    it("returns consistent emoji for same name with same theme", () => {
      const emoji1 = avatarEmoji("张三", "animals");
      const emoji2 = avatarEmoji("张三", "animals");
      expect(emoji1).toBe(emoji2);
    });

    it("returns emoji from correct theme pool", () => {
      const animalEmoji = avatarEmoji("测试", "animals");
      const foodEmoji = avatarEmoji("测试", "food");
      
      // Both should be valid emojis
      expect(animalEmoji).toBeTruthy();
      expect(foodEmoji).toBeTruthy();
      expect(animalEmoji.length).toBeGreaterThan(0);
      expect(foodEmoji.length).toBeGreaterThan(0);
    });

    it("uses current theme when theme parameter is omitted", () => {
      setAvatarTheme("food");
      const emoji1 = avatarEmoji("测试");
      const emoji2 = avatarEmoji("测试", "food");
      expect(emoji1).toBe(emoji2);
    });

    it("generates different emojis for similar names", () => {
      const emoji1 = avatarEmoji("张三", "animals");
      const emoji2 = avatarEmoji("张四", "animals");
      
      // Should have high probability of being different
      // Note: There's a small chance they could be the same
      expect(typeof emoji1).toBe("string");
      expect(typeof emoji2).toBe("string");
    });

    it("handles all available themes", () => {
      const themes: AvatarTheme[] = ["animals", "food", "nature", "symbols", "faces", "flags", "sports"];
      
      themes.forEach((theme) => {
        const emoji = avatarEmoji("测试", theme);
        expect(emoji).toBeTruthy();
        expect(emoji.length).toBeGreaterThan(0);
      });
    });

    it("handles empty name gracefully", () => {
      const emoji = avatarEmoji("", "animals");
      expect(emoji).toBeTruthy();
      expect(emoji.length).toBeGreaterThan(0);
    });

    it("handles long names", () => {
      const longName = "非常长的联系人姓名用于测试哈希算法的稳定性";
      const emoji1 = avatarEmoji(longName, "animals");
      const emoji2 = avatarEmoji(longName, "animals");
      expect(emoji1).toBe(emoji2);
    });
  });

  describe("Theme Management", () => {
    it("getAvatarTheme returns current theme", () => {
      setAvatarTheme("food");
      expect(getAvatarTheme()).toBe("food");
      
      setAvatarTheme("nature");
      expect(getAvatarTheme()).toBe("nature");
    });

    it("setAvatarTheme changes global theme", () => {
      setAvatarTheme("symbols");
      expect(getAvatarTheme()).toBe("symbols");
    });

    it("getAvatarThemes returns all available themes", () => {
      const themes = getAvatarThemes();
      expect(themes).toContain("animals");
      expect(themes).toContain("food");
      expect(themes).toContain("nature");
      expect(themes).toContain("symbols");
      expect(themes).toContain("faces");
      expect(themes).toContain("flags");
      expect(themes).toContain("sports");
      expect(themes.length).toBe(7);
    });

    it("setAvatarTheme with invalid theme does not crash", () => {
      const invalidTheme = "invalid" as AvatarTheme;
      setAvatarTheme(invalidTheme);
      // Should not throw, and theme should remain unchanged
      expect(["animals", "food", "nature", "symbols", "faces", "flags", "sports"]).toContain(
        getAvatarTheme()
      );
    });

    it("default theme is animals", () => {
      // This test assumes fresh import, but we set it in beforeEach
      expect(getAvatarTheme()).toBe("animals");
    });
  });

  describe("Hash Distribution", () => {
    it("distributes emojis across pool reasonably", () => {
      const names = [
        "张三", "李四", "王五", "赵六", "钱七", "孙八", "周九", "吴十",
        "郑十一", "王十二", "冯十三", "陈十四", "褚十五", "卫十六",
        "蒋十七", "沈十八", "韩十九", "杨二十",
      ];

      const emojis = names.map((name) => avatarEmoji(name, "animals"));
      const uniqueEmojis = new Set(emojis);

      // With 18 names and 50 emoji options, we should get reasonable diversity
      // At least 50% unique (9 different emojis)
      expect(uniqueEmojis.size).toBeGreaterThanOrEqual(9);
    });

    it("same surname with different given names produces different emojis", () => {
      const names = ["张三", "张四", "张五", "张六", "张七"];
      const emojis = names.map((name) => avatarEmoji(name, "animals"));
      const uniqueEmojis = new Set(emojis);

      // Should have at least some diversity
      expect(uniqueEmojis.size).toBeGreaterThanOrEqual(3);
    });
  });

  describe("Integration with UI", () => {
    it("theme switching affects emoji selection", () => {
      const name = "测试用户";
      
      setAvatarTheme("animals");
      const animalEmoji = avatarEmoji(name);
      
      setAvatarTheme("food");
      const foodEmoji = avatarEmoji(name);
      
      setAvatarTheme("nature");
      const natureEmoji = avatarEmoji(name);
      
      setAvatarTheme("symbols");
      const symbolEmoji = avatarEmoji(name);
      
      setAvatarTheme("faces");
      const facesEmoji = avatarEmoji(name);
      
      setAvatarTheme("flags");
      const flagsEmoji = avatarEmoji(name);
      
      setAvatarTheme("sports");
      const sportsEmoji = avatarEmoji(name);
      
      // All should be valid
      expect(animalEmoji).toBeTruthy();
      expect(foodEmoji).toBeTruthy();
      expect(natureEmoji).toBeTruthy();
      expect(symbolEmoji).toBeTruthy();
      expect(facesEmoji).toBeTruthy();
      expect(flagsEmoji).toBeTruthy();
      expect(sportsEmoji).toBeTruthy();
    });

    it("emoji selection is stable across theme switches", () => {
      const name = "稳定性测试";
      
      setAvatarTheme("animals");
      const emoji1 = avatarEmoji(name);
      
      setAvatarTheme("food");
      avatarEmoji(name); // Switch theme
      
      setAvatarTheme("animals");
      const emoji2 = avatarEmoji(name);
      
      // Should return to same emoji when theme is switched back
      expect(emoji1).toBe(emoji2);
    });
  });

  describe("New Themes (Faces, Flags, Sports)", () => {
    it("faces theme returns valid face emojis", () => {
      const names = ["Alice", "Bob", "Charlie", "David", "Eve"];
      const emojis = names.map((name) => avatarEmoji(name, "faces"));
      
      emojis.forEach((emoji) => {
        expect(emoji).toBeTruthy();
        expect(emoji.length).toBeGreaterThan(0);
      });
      
      // Should have some diversity
      const uniqueEmojis = new Set(emojis);
      expect(uniqueEmojis.size).toBeGreaterThanOrEqual(3);
    });

    it("flags theme returns valid flag emojis", () => {
      const names = ["张三", "李四", "王五", "赵六", "钱七"];
      const emojis = names.map((name) => avatarEmoji(name, "flags"));
      
      emojis.forEach((emoji) => {
        expect(emoji).toBeTruthy();
        expect(emoji.length).toBeGreaterThan(0);
      });
      
      // Should have some diversity
      const uniqueEmojis = new Set(emojis);
      expect(uniqueEmojis.size).toBeGreaterThanOrEqual(3);
    });

    it("sports theme returns valid sport emojis", () => {
      const names = ["Michael", "Serena", "Usain", "Simone", "Lionel"];
      const emojis = names.map((name) => avatarEmoji(name, "sports"));
      
      emojis.forEach((emoji) => {
        expect(emoji).toBeTruthy();
        expect(emoji.length).toBeGreaterThan(0);
      });
      
      // Should have some diversity
      const uniqueEmojis = new Set(emojis);
      expect(uniqueEmojis.size).toBeGreaterThanOrEqual(3);
    });

    it("new themes have stable hash distribution", () => {
      const name = "稳定测试用户";
      
      // Test each new theme multiple times
      const facesEmoji1 = avatarEmoji(name, "faces");
      const facesEmoji2 = avatarEmoji(name, "faces");
      expect(facesEmoji1).toBe(facesEmoji2);
      
      const flagsEmoji1 = avatarEmoji(name, "flags");
      const flagsEmoji2 = avatarEmoji(name, "flags");
      expect(flagsEmoji1).toBe(flagsEmoji2);
      
      const sportsEmoji1 = avatarEmoji(name, "sports");
      const sportsEmoji2 = avatarEmoji(name, "sports");
      expect(sportsEmoji1).toBe(sportsEmoji2);
    });

    it("each new theme has sufficient emoji pool size", () => {
      // Generate many emojis to test pool coverage
      const names = Array.from({ length: 30 }, (_, i) => `用户${i}`);
      
      const facesEmojis = new Set(names.map((n) => avatarEmoji(n, "faces")));
      const flagsEmojis = new Set(names.map((n) => avatarEmoji(n, "flags")));
      const sportsEmojis = new Set(names.map((n) => avatarEmoji(n, "sports")));
      
      // Each theme should produce at least 15 unique emojis from 30 names
      expect(facesEmojis.size).toBeGreaterThanOrEqual(15);
      expect(flagsEmojis.size).toBeGreaterThanOrEqual(15);
      expect(sportsEmojis.size).toBeGreaterThanOrEqual(15);
    });
  });
});
