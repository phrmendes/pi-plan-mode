{ pkgs, ... }:

{
  name = "pi-plan-mode";

  languages = {
    javascript = {
      enable = true;
      pnpm = {
        enable = true;
        install.enable = true;
      };
    };
  };

  git-hooks.hooks = {
    format = {
      enable = true;
      entry = "pnpm format";
      files = "\\.(ts|json|md)$";
      package = pkgs.pnpm;
    };
  };
}
