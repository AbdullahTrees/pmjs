"""Import author-supplied PortMaster metadata for a self-contained PMJS port."""
import json
import re
import shutil
from pathlib import Path
from xml.etree import ElementTree


PORTNAME = re.compile(r'[a-z0-9][a-z0-9._]*\Z')


def _regular(file):
    if file.is_symlink() or not file.is_file():
        raise ValueError(f'Missing or non-regular submission file: {file}')
    return file


def _image(directory, stem, required):
    images = [directory / (stem + suffix) for suffix in ('.png', '.jpg')
              if (directory / (stem + suffix)).exists()]
    if len(images) > 1 or (required and not images):
        raise ValueError(f'Expected {"one" if required else "at most one"} {stem}.png/.jpg')
    if not images:
        return None
    return _regular(images[0])


def read_submission(directory):
    """Read the files normally authored for a PortMaster-New port PR."""
    if directory is None:
        return None
    directory = Path(directory).resolve()
    portname = directory.name
    if not PORTNAME.fullmatch(portname) or not directory.is_dir():
        raise ValueError('Submission must be a directory with a valid PortMaster portname')
    metadata = json.loads(_regular(directory / 'port.json').read_text(encoding='utf-8'))
    if not isinstance(metadata, dict) or metadata.get('version') != 4 or metadata.get('name') != portname + '.zip':
        raise ValueError('Expected PortMaster v4 port.json matching the submission directory')
    items = metadata.get('items')
    if not isinstance(items, list) or len(items) != 2 or items[1] != portname:
        raise ValueError('port.json items must specify the launcher and this port directory')
    launcher = items[0]
    if not isinstance(launcher, str) or not launcher.endswith('.sh') or not launcher[:-3] or re.search(r'[\x00-\x1f/\\]', launcher):
        raise ValueError('Invalid PortMaster launcher name in port.json')
    attr = metadata.get('attr')
    if not isinstance(attr, dict) or attr.get('rtr') is not False or attr.get('runtime') != []:
        raise ValueError('PMJS submission must require game data (rtr=false) and bundle its own runtime')
    if not isinstance(attr.get('arch'), list) or len(attr['arch']) != 1:
        raise ValueError('port.json must select exactly one PMJS architecture')

    _regular(directory / 'README.md')
    xml = _regular(directory / 'gameinfo.xml')
    try:
        root = ElementTree.parse(xml).getroot()
    except ElementTree.ParseError as error:
        raise ValueError('Invalid gameinfo.xml') from error
    game = root.find('game') if root.tag == 'gameList' else None
    if game is None or game.findtext('path') != './' + launcher:
        raise ValueError('gameinfo.xml path must match the launcher')
    screenshot = _image(directory, 'screenshot', required=True)
    cover = _image(directory, 'cover', required=False)
    expected_images = {'./' + portname + '/' + (cover or screenshot).name,
                       './' + portname + '/' + screenshot.name}
    if game.findtext('image') not in expected_images:
        raise ValueError('gameinfo.xml image must reference the screenshot or cover')
    return {'directory': directory, 'portname': portname, 'launcher': launcher,
            'metadata': metadata, 'screenshot': screenshot, 'cover': cover}


def stage_submission(port, data, stage, info, notices, extra_notices):
    """Stage official source metadata in the layout of PortMaster's release ZIPs."""
    architecture = {'arm64': 'aarch64', 'aarch64': 'aarch64',
                    'x64': 'x86_64', 'x86_64': 'x86_64'}.get(info['architecture'])
    if architecture is None or data['metadata']['attr']['arch'] != [architecture]:
        raise ValueError('port.json architecture does not match the packaged runtime')
    source = data['directory']
    shutil.copyfile(source / 'port.json', port / 'port.json')
    shutil.copyfile(source / 'README.md', port / (data['portname'] + '.md'))
    shutil.copyfile(source / 'gameinfo.xml', port / 'gameinfo.xml')
    for file in (data['screenshot'], data['cover']):
        if file:
            shutil.copyfile(file, port / file.name)

    licenses = port / 'licenses'
    licenses.mkdir()
    used = set()
    for file in (*notices, *extra_notices):
        _regular(file)
        try:
            origin = file.relative_to(stage).as_posix()
        except ValueError:
            origin = 'additional/' + file.name
        label = re.sub(r'[^a-z0-9]+', '_', origin.lower()).strip('_')
        if not label or label in used:
            raise ValueError('Conflicting license name: ' + str(file))
        used.add(label)
        shutil.copyfile(file, licenses / ('LICENSE.' + label + '.txt'))
    if info.get('dependencySources'):
        (licenses / 'FFMPEG_SOURCES.txt').write_text(
            'Matching FFmpeg source and build materials: ' + info['dependencySources']['url'] + '\n',
            encoding='utf-8')
