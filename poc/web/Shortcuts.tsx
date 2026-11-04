// The keyboard shortcuts panel (? or ⌘/Ctrl+/), written the way this system writes keys (⌘ on macOS, Ctrl elsewhere).
import { Modal } from "./Dialogs.tsx";
import { useT, type T } from "./i18n.tsx";
import { IS_MAC, kbd } from "./keys.ts";

const groups = (t: T): { title: string; rows: [string, string[]][] }[] => [
  {
    title: t("Tools", "도구"),
    rows: [
      [t("Move", "이동"), ["V"]],
      [t("Hand tool", "손 도구"), ["H"]],
      [t("Pan while held", "누르는 동안 화면 이동"), [kbd("space")]],
      [t("Link frames", "프레임 연결"), ["L"]],
      [t("New note at the pointer", "포인터 위치에 메모"), ["N"]],
      [t("New checklist at the pointer", "포인터 위치에 체크리스트"), ["C"]],
      [t("New browser", "새 브라우저"), ["B"]],
      [t("Open a code editor", "코드 편집기 열기"), ["E"]],
      [t("Section: draw one, or put the selection in one", "섹션: 그리기, 또는 선택한 것을 섹션으로"), [kbd("shift+s")]],
    ],
  },
  {
    title: t("Sections", "섹션"),
    rows: [
      [t("Put the selection in a new section", "선택한 것을 새 섹션으로 묶기"), [kbd("shift+s"), kbd("mod+alt+s")]],
      [t("Move a section and what is in it", "섹션과 안의 것을 함께 옮기기"), [t("Drag its name", "이름을 드래그")]],
      [t("Remove the section, keep what is in it", "섹션만 없애기 (안의 것은 남김)"), [kbd("mod+shift+g")]],
      [t("Delete the section and what is in it", "섹션과 안의 것 삭제"), [kbd("delete")]],
      [t("Send a section to Claude", "섹션을 Claude에게 보내기"), [kbd("mod+enter"), "@" + t("name", "이름")]],
    ],
  },
  {
    title: t("View", "보기"),
    rows: [
      [t("Pan", "화면 이동"), [t("Scroll", "스크롤"), t("Middle-drag", "가운데 버튼 드래그")]],
      [t("Zoom at the pointer", "포인터 위치 확대/축소"), [`${kbd("mod")} + ${t("scroll", "스크롤")}`, t("Pinch", "핀치")]],
      [t("Zoom in / out", "확대 / 축소"), [kbd("mod+plus"), kbd("mod+minus")]],
      [t("Zoom to 100%", "100%로"), [kbd("shift+0")]],
      [t("Zoom to fit all", "전체 보기"), [kbd("shift+1")]],
      [t("Zoom to selection", "선택 영역에 맞추기"), [kbd("shift+2")]],
      [t("Properties panel", "속성 패널"), [kbd("mod+\\")]],
    ],
  },
  {
    title: t("Selection", "선택"),
    rows: [
      [t("Select several", "여러 개 선택"), [t("Drag on empty space", "빈 곳 드래그"), `${kbd("shift")} + ${t("click", "클릭")}`]],
      [t("Select all", "모두 선택"), [kbd("mod+a")]],
      [t("Deselect · stop editing", "선택 해제 · 편집 끝내기"), [kbd("escape")]],
      [t("Edit the selected frame", "선택한 프레임 편집"), [kbd("enter")]],
      [t("Move 1 / 10", "1칸 / 10칸 이동"), [`${kbd("up")}${kbd("down")}${kbd("left")}${kbd("right")}`, `${kbd("shift")} + ${t("arrows", "화살표")}`]],
      [t("Undo · redo", "실행 취소 · 다시 실행"), [kbd("mod+z"), IS_MAC ? kbd("mod+shift+z") : kbd("ctrl+y")]],
      [t("Copy · cut · paste", "복사 · 잘라내기 · 붙여넣기"), [kbd("mod+c"), kbd("mod+x"), kbd("mod+v")]],
      [t("Duplicate", "복제"), [kbd("mod+d")]],
      [t("Delete", "삭제"), [kbd("delete")]],
      [t("Rename", "이름 바꾸기"), [t("Double-click the name", "이름 더블클릭")]],
    ],
  },
  {
    title: "Claude",
    rows: [
      [t("Ask Claude (input box)", "Claude에게 말하기 (입력창)"), ["/"]],
      [t("Send the selection to Claude", "선택한 것을 Claude에게 보내기"), [kbd("mod+enter")]],
      [t("Terminal", "터미널"), [kbd("ctrl+`")]],
      [t("Keyboard shortcuts", "단축키"), ["?"]],
    ],
  },
];

export function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  const t = useT();
  return (
    <Modal title={t("Keyboard shortcuts", "단축키")} onClose={onClose} wide>
      <div className="shortcuts">
        {groups(t).map((g) => (
          <section key={g.title}>
            <h4>{g.title}</h4>
            <dl>
              {g.rows.map(([what, keys]) => (
                <div key={what} className="shortcut-row">
                  <dt>{what}</dt>
                  <dd>
                    {keys.map((k, i) => (
                      <kbd key={i}>{k}</kbd>
                    ))}
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </Modal>
  );
}
