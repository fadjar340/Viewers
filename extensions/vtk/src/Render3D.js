import React from 'react';
import { Component } from 'react';
import { getImageData, loadImageData, View3D, imageDataCache } from 'react-vtkjs-viewport';
import vtkVolume from 'vtk.js/Sources/Rendering/Core/Volume';
import vtkVolumeMapper from 'vtk.js/Sources/Rendering/Core/VolumeMapper';
import { api } from 'dicomweb-client';
import cornerstoneWADOImageLoader from 'cornerstone-wado-image-loader';
import './initCornerstone.js';
import vtkColorTransferFunction from 'vtk.js/Sources/Rendering/Core/ColorTransferFunction';
import vtkPiecewiseFunction from 'vtk.js/Sources/Common/DataModel/PiecewiseFunction';
import vtkColorMaps from 'vtk.js/Sources/Rendering/Core/ColorTransferFunction/ColorMaps';
import presets from './presets.js';


window.cornerstoneWADOImageLoader = cornerstoneWADOImageLoader;

//const url = '/viewer/wadouri?requestType=WADO';
//const url = 'https://ohif.ecalyptus.healthcare/viewer/rs';
const url = 'https://dsm4chee.ecalyptus.healthcare/dcm4chee-arc/aets/DCM4CHEE/rs';
//const server = window.config.servers;
//const url = server.DicomWeb.qidoRoot;

const SOP_INSTANCE_UID = '00080018';
const SERIES_INSTANCE_UID = '0020000E';

var studyInstanceUID =
  '1.3.6.1.4.1.14519.5.2.1.7009.2403.334240657131972136850343327463';
var ctSeriesInstanceUID =
  '1.3.6.1.4.1.14519.5.2.1.7009.2403.226151125820845824875394858561';

var ctSOPInstanceUID =
  '1.2.392.200036.9123.100.11.15225270322541066167029930009175335';

var searchInstanceOptions = {
    studyInstanceUID,
};

function createActorMapper(imageData) {
  const mapper = vtkVolumeMapper.newInstance();
  mapper.setInputData(imageData);

  const actor = vtkVolume.newInstance();
  actor.setMapper(mapper);

  return {
    actor,
    mapper,
  };
}

function getShiftRange(colorTransferArray) {
  // Credit to paraview-glance
  // https://github.com/Kitware/paraview-glance/blob/3fec8eeff31e9c19ad5b6bff8e7159bd745e2ba9/src/components/controls/ColorBy/script.js#L133

  // shift range is original rgb/opacity range centered around 0
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < colorTransferArray.length; i += 4) {
    min = Math.min(min, colorTransferArray[i]);
    max = Math.max(max, colorTransferArray[i]);
  }

  const center = (max - min) / 2;

  return {
    shiftRange: [-center, center],
    min,
    max,
  };
}

function applyPointsToPiecewiseFunction(points, range, pwf) {
  const width = range[1] - range[0];
  const rescaled = points.map(([x, y]) => [x * width + range[0], y]);

  pwf.removeAllPoints();
  rescaled.forEach(([x, y]) => pwf.addPoint(x, y));

  return rescaled;
}

function applyPointsToRGBFunction(points, range, cfun) {
  const width = range[1] - range[0];
  const rescaled = points.map(([x, r, g, b]) => [
    x * width + range[0],
    r,
    g,
    b,
  ]);

  cfun.removeAllPoints();
  rescaled.forEach(([x, r, g, b]) => cfun.addRGBPoint(x, r, g, b));

  return rescaled;
}

// Preset button by actor
function applyPreset(actor, preset) {
  // Create color transfer function
  const colorTransferArray = preset.colorTransfer
    .split(' ')
    .splice(1)
    .map(parseFloat);

  const { shiftRange } = getShiftRange(colorTransferArray);
  let min = shiftRange[0];
  const width = shiftRange[1] - shiftRange[0];
  const cfun = vtkColorTransferFunction.newInstance();
  const normColorTransferValuePoints = [];
  for (let i = 0; i < colorTransferArray.length; i += 4) {
    let value = colorTransferArray[i];
    const r = colorTransferArray[i + 1];
    const g = colorTransferArray[i + 2];
    const b = colorTransferArray[i + 3];

    value = (value - min) / width;
    normColorTransferValuePoints.push([value, r, g, b]);
  }

  applyPointsToRGBFunction(normColorTransferValuePoints, shiftRange, cfun);

  actor.getProperty().setRGBTransferFunction(0, cfun);

  // Create scalar opacity function
  const scalarOpacityArray = preset.scalarOpacity
    .split(' ')
    .splice(1)
    .map(parseFloat);

  const ofun = vtkPiecewiseFunction.newInstance();
  const normPoints = [];
  for (let i = 0; i < scalarOpacityArray.length; i += 2) {
    let value = scalarOpacityArray[i];
    const opacity = scalarOpacityArray[i + 1];

    value = (value - min) / width;

    normPoints.push([value, opacity]);
  }

  applyPointsToPiecewiseFunction(normPoints, shiftRange, ofun);

  actor.getProperty().setScalarOpacity(0, ofun);

  const [
    gradientMinValue,
    gradientMinOpacity,
    gradientMaxValue,
    gradientMaxOpacity,
  ] = preset.gradientOpacity
    .split(' ')
    .splice(1)
    .map(parseFloat);

  actor.getProperty().setUseGradientOpacity(0, true);
  actor.getProperty().setGradientOpacityMinimumValue(0, gradientMinValue);
  actor.getProperty().setGradientOpacityMinimumOpacity(0, gradientMinOpacity);
  actor.getProperty().setGradientOpacityMaximumValue(0, gradientMaxValue);
  actor.getProperty().setGradientOpacityMaximumOpacity(0, gradientMaxOpacity);

  if (preset.interpolation === '1') {
    actor.getProperty().setInterpolationTypeToFastLinear();
    //actor.getProperty().setInterpolationTypeToLinear()
  }

  const ambient = parseFloat(preset.ambient);
  //const shade = preset.shade === '1'
  const diffuse = parseFloat(preset.diffuse);
  const specular = parseFloat(preset.specular);
  const specularPower = parseFloat(preset.specularPower);

  //actor.getProperty().setShade(shade)
  actor.getProperty().setAmbient(ambient);
  actor.getProperty().setDiffuse(diffuse);
  actor.getProperty().setSpecular(specular);
  actor.getProperty().setSpecularPower(specularPower);
}

function createCT3dPipeline(imageData, ctTransferFunctionPresetId) {
  const { actor, mapper } = createActorMapper(imageData);

  const sampleDistance =
    1.2 *
    Math.sqrt(
      imageData
        .getSpacing()
        .map(v => v * v)
        .reduce((a, b) => a + b, 0)
    );

  const range = imageData
    .getPointData()
    .getScalars()
    .getRange();
  actor
    .getProperty()
    .getRGBTransferFunction(0)
    .setRange(range[0], range[1]);

  mapper.setSampleDistance(sampleDistance);

  const preset = presets.find(
    preset => preset.id === ctTransferFunctionPresetId
  );

  applyPreset(actor, preset);

  actor.getProperty().setScalarOpacityUnitDistance(0, 2.5);

  return actor;
}

//similar like getviewportdata
function createStudyImageIds(baseUrl, studySearchOptions) {
  //const SOP_INSTANCE_UID = '00080018';
  //const SERIES_INSTANCE_UID = '0020000E';

  const client = new api.DICOMwebClient({ url });

  studyInstanceUID = localStorage.getItem('StudyInstanceUID');
  ctSeriesInstanceUID = localStorage.getItem('SeriesInstanceUID');
  //ctSOPInstanceUID = localStorage.getItem('SOPInstanceUID');

  searchInstanceOptions = {
    studyInstanceUID,
  };
  studySearchOptions = {
    studyInstanceUID,
  }
 console.log('Study Instance UID', studyInstanceUID);
 console.log('CT Series Instance UID', ctSeriesInstanceUID);

 return new Promise((resolve, reject) => {
  client.retrieveStudyMetadata(studySearchOptions).then(instances => {
    const imageIds = instances.map(metaData => {
      const imageId =
        `wadors:` +
        baseUrl +
        '/studies/' +
        studyInstanceUID +
        '/series/' +
        metaData[SERIES_INSTANCE_UID].Value[0] +
        '/instances/' +
        metaData[SOP_INSTANCE_UID].Value[0] +
        '/frames/1';

      cornerstoneWADOImageLoader.wadors.metaDataManager.add(
        imageId,
        metaData
      );

      return imageId;
    });

    resolve(imageIds);
  }, reject);
});
}


//main class
class Render3D extends Component {
  state = {
    volumeRenderingVolumes: null,
    ctTransferFunctionPresetId: 'vtkMRMLVolumePropertyNode4',
    petColorMapId: 'hsv',
  };

  async componentDidMount() {
    const imageIdPromise = createStudyImageIds(url, searchInstanceOptions);
  /*  console.log("SearchInstance", searchInstanceOptions);
    console.log("My_test_uid", my_test_uid);
    */
    console.log("studyInstanceUID",studyInstanceUID);
    this.apis = [];

    const imageIds = await imageIdPromise;
    let ctImageIds = imageIds.filter(imageId =>
      imageId.includes(ctSeriesInstanceUID)
    );
    //ctImageIds = ctImageIds.slice(0, ctImageIds.length / 2);

    console.log('Image ID', ctImageIds);
    const ctImageDataObject = this.loadDataset(ctImageIds, 'ctDisplaySet');

    const ctImageData = ctImageDataObject.vtkImageData;
    const ctVolVR = createCT3dPipeline(
      ctImageData,
      this.state.ctTransferFunctionPresetId
    );

    this.setState({
      volumeRenderingVolumes: [ctVolVR],
      percentComplete: 0,
    });
  }

  saveApiReference = api => {
    this.apis = [api];
  };

  handleChangeCTTransferFunction = event => {
    const ctTransferFunctionPresetId = event.target.value;
    const preset = presets.find(
      preset => preset.id === ctTransferFunctionPresetId
    );

    const actor = this.state.volumeRenderingVolumes[0];

    applyPreset(actor, preset);

    this.rerenderAll();

    this.setState({
      ctTransferFunctionPresetId,
    });
  };

  rerenderAll = () => {
    // Update all render windows, since the automatic re-render might not
    // happen if the viewport is not currently using the painting widget
    Object.keys(this.apis).forEach(viewportIndex => {
      const renderWindow = this.apis[
        viewportIndex
      ].genericRenderWindow.getRenderWindow();

      renderWindow.render();
    });
  };

  loadDataset(imageIds, displaySetInstanceUid) {
    imageDataCache.clear();
    //localStorage.clear();
    const imageDataObject = getImageData(imageIds, displaySetInstanceUid);
    //localStorage.clear();
    loadImageData(imageDataObject);

    const numberOfFrames = imageIds.length;

    const onPixelDataInsertedCallback = numberProcessed => {
      const percentComplete = Math.floor(
        (numberProcessed * 100) / numberOfFrames
      );

      if (this.state.percentComplete !== percentComplete) {
        this.setState({ percentComplete });
      }

      if (percentComplete % 20 === 0) {
        this.rerenderAll();
      }
    };

    const onAllPixelDataInsertedCallback = () => {
      this.rerenderAll();
    };

    imageDataObject.onPixelDataInserted(onPixelDataInsertedCallback);
    imageDataObject.onAllPixelDataInserted(onAllPixelDataInsertedCallback);

    return imageDataObject;
  }

  render() {
    if (!this.state.volumeRenderingVolumes) {
      return <h4>Loading...</h4>;
    }

    const ctTransferFunctionPresetOptions = presets.map(preset => {
      return (
        <option key={preset.id} value={preset.id}>
          {preset.name}
        </option>
      );
    });

    const { percentComplete } = this.state;

    const progressString = `Progress: ${percentComplete}%`;
    const style = { width: '100%', height: '100%', position: 'relative' };
    return (
      <>
        <div className="row">
          <div className="col-xs-12">
            <div>
              <label htmlFor="select_CT_xfer_fn">
                CT Transfer Function Preset (for Volume Rendering):{'    '}
              </label>
              <select
                id="select_CT_xfer_fn"
                value={this.state.ctTransferFunctionPresetId}
                onChange={this.handleChangeCTTransferFunction}
              >
                {ctTransferFunctionPresetOptions}
              </select>
            </div>
          </div>
          <div className="col-xs-12 col-sm-6">
            <View3D
              volumes={this.state.volumeRenderingVolumes}
              onCreated={this.saveApiReference}
            />
          </div>
      </div>
          </>
      );
  }
}

export default Render3D;
