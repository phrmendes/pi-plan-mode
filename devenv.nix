{ pkgs, ... }:

{
  name = "pi-plan-mode";

  languages.javascript = {
    enable = true;
    pnpm = {
      enable = true;
      install.enable = true;
    };
  };

  # languages.typescript ships the classic tsc; tsgo provides both the
  # compiler (tsc/tsgo) and the LSP
  packages = [ pkgs.typescript-go ];
}
