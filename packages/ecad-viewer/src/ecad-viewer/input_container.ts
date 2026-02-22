export interface InputContainer {
    input: HTMLInputElement;
    target: HTMLElement;
    on_full_windows: () => void;
    on_open_file?: () => void;
}
