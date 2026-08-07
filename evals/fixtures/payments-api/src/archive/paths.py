"""Archive layout. PLANTED: string path manipulation — slashes concatenated
by hand, extensions split on '.'; use pathlib throughout."""


def archive_path(root, account, year, month, name):
    path = root
    if not path.endswith("/"):
        path = path + "/"
    path = path + account + "/" + str(year) + "/" + str(month).zfill(2)
    return path + "/" + name


def with_suffix(path, suffix):
    parts = path.split("/")
    filename = parts[-1]
    if "." in filename:
        filename = filename[: filename.rindex(".")]
    parts[-1] = filename + suffix
    return "/".join(parts)
