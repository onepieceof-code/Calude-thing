using {cuid} from '@sap/cds/common';

@odata
service ToDo_Service {
  entity ToDo : cuid {
    task     : String(500);
    complete : Boolean default false;
  }
}
