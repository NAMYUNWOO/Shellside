// The components Shellside comes with: in the library (they can't be removed from it) and in the toolbar's + menu.
import type { T } from "./i18n.tsx";

export type BuiltinKind = "note" | "checklist" | "table" | "form" | "browser" | "code" | "file" | "section";
export interface Builtin {
  id: `builtin:${BuiltinKind}`;
  kind: BuiltinKind;
  name: string;
  description: string;
  /** Its key on the board (see Shortcuts.tsx). */
  key?: string;
}

export const builtins = (t: T): Builtin[] => [
  { id: "builtin:note", kind: "note", key: "N", name: t("Note", "메모"), description: t("Text that saves as you type", "입력하는 대로 저장되는 글") },
  { id: "builtin:checklist", kind: "checklist", key: "C", name: t("Checklist", "체크리스트"), description: t("Steps to tick off; Claude can gate one on your approval", "체크할 단계들. Claude가 단계마다 승인을 받게 할 수 있음") },
  { id: "builtin:table", kind: "table", name: t("Table", "표"), description: t("Rows and columns, e.g. a task list", "행과 열. 예: 작업 목록") },
  { id: "builtin:form", kind: "form", name: t("Form", "폼"), description: t("Fields to fill in and submit", "채워서 제출하는 입력 칸") },
  { id: "builtin:browser", kind: "browser", key: "B", name: t("Browser", "브라우저"), description: t("A web browser you and Claude share", "나와 Claude가 함께 쓰는 웹 브라우저") },
  { id: "builtin:code", kind: "code", key: "E", name: t("Code editor", "코드 편집기"), description: t("Edit a folder, a project or a file (Monaco)", "폴더, 프로젝트, 파일을 편집 (Monaco)") },
  { id: "builtin:file", kind: "file", name: t("File…", "파일…"), description: t("Pick files from this computer (or drop them on the board)", "이 컴퓨터의 파일 고르기 (보드에 끌어다 놓아도 됨)") },
  { id: "builtin:section", kind: "section", key: "⇧S", name: t("Section", "섹션"), description: t("A named area that groups frames", "프레임을 묶는 이름 붙은 영역") },
];
