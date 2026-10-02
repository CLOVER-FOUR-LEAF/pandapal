import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from '../web/vendor/three.module.min.js';
import { createPanda, updatePanda, setPandaMood, triggerWave, getFaceCount, PANDA_MOODS } from '../web/panda3d.js';

function dispose(panda) {
  const resources = new Set(panda.userData.textures);
  panda.traverse(object => {
    if (object.geometry) resources.add(object.geometry);
    if (object.material) resources.add(object.material);
  });
  for (const resource of resources) resource.dispose();
}

test('all moods preserve placement, finite geometry, and the attached notebook', () => {
  const panda = createPanda(THREE, { scale: 0.8 });
  panda.position.set(3, -2, 1);
  const position = panda.position.clone();
  const { armL, padGroup } = panda.userData.parts;
  const notebookPosition = padGroup.position.clone();
  try {
    for (const mood of PANDA_MOODS) {
      setPandaMood(panda, mood);
      for (let i = 0; i < 180; i++) updatePanda(panda, 1 / 60);
      panda.updateMatrixWorld(true);
      assert.deepEqual(panda.position, position, mood + ' moved the scene-owned root');
      assert.equal(panda.scale.x, 0.8);
      assert.equal(padGroup.parent, armL, mood + ' detached the notebook');
      assert.deepEqual(padGroup.position, notebookPosition);
      panda.traverse(object => {
        assert.ok(object.matrixWorld.elements.every(Number.isFinite));
        if (object.geometry) assert.ok(object.geometry.attributes.position.array.every(Number.isFinite));
      });
    }
    setPandaMood(panda, 'unknown');
    assert.equal(panda.userData.mood, 'idle');
  } finally { dispose(panda); }
});

test('wave has continuous entry and exit without moving the root', () => {
  const panda = createPanda(THREE);
  try {
    updatePanda(panda, 1 / 60);
    const { armR } = panda.userData.parts;
    const start = armR.rotation.x;
    triggerWave(panda);
    updatePanda(panda, 1 / 60);
    assert.ok(Math.abs(armR.rotation.x - start) < 0.25);
    for (let i = 0; i < 47; i++) updatePanda(panda, 1 / 60);
    assert.ok(armR.rotation.x < -1.8, 'hand did not rise');
    for (let i = 0; i < 60; i++) updatePanda(panda, 1 / 60);
    assert.ok(Math.abs(armR.rotation.x - start) < 0.03, 'hand did not settle');
    assert.equal(panda.position.length(), 0);
  } finally { dispose(panda); }
});

test('felt assets stay nonmetallic, locally generated and within geometry budget', () => {
  const panda = createPanda(THREE);
  try {
    assert.ok(getFaceCount(panda) < 80000);
    assert.ok(panda.userData.textures.every(texture => texture.isDataTexture));
    const { head, body } = panda.userData.parts;
    for (const mesh of [head, body]) {
      assert.equal(mesh.material.metalness, 0);
      assert.ok(mesh.material.roughness >= 0.9);
      assert.ok(mesh.material.specularIntensity < 0.3);
      assert.ok(mesh.getObjectByName('felt-pile'));
    }
  } finally { dispose(panda); }
});

test('fur receives the same shadows and surface color as the skin', () => {
  const panda = createPanda(THREE);
  try {
    panda.traverse(object => {
      if (object.name !== 'felt-pile') return;
      const skin = object.parent.material;
      assert.ok(object.receiveShadow, 'unshadowed fibers create bright dots in shade');
      assert.ok(object.material.color.equals(skin.color));
      assert.equal(object.material.map, skin.map);
      assert.equal(object.material.roughness, skin.roughness);
      assert.equal(object.material.depthWrite, false);
      for (const name of ['normal', 'uv', 'furCoord']) {
        assert.ok(object.geometry.attributes[name].array.every(Number.isFinite), name);
      }
    });
    const { material } = panda.userData.parts.head;
    assert.equal(material.bumpMap, null);
    assert.ok(panda.userData.textures.includes(material.normalMap));
    const { data } = material.map.image;
    for (let i = 0; i < data.length; i += 4) {
      assert.ok(data[i] >= 235 && data[i] <= 250, 'fur albedo contains a high-contrast fleck');
    }
  } finally { dispose(panda); }
});
